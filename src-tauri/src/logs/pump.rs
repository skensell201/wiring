//! Reads one container's log stream line by line and forwards it in batches (spec §4: flush
//! every 50 ms or 256 lines). Generic over `AsyncBufRead` so it is tested without a cluster.
//!
//! Lines are decoded lossily (a stray byte becomes U+FFFD instead of ending the stream) and a
//! line longer than [`MAX_LINE_BYTES`] is split into cap-sized pieces rather than buffered
//! whole, so a container that never prints a newline cannot grow memory without bound.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::time::{timeout_at, Instant};

use super::{LogLine, LogMessage, LogSink};

/// Longest line the pump emits (1 MiB); longer output is split into consecutive lines. A
/// split may land inside a multi-byte sequence (U+FFFD at the edges) or between `\r` and
/// `\n`; at this granularity that is cosmetic and accepted.
pub const MAX_LINE_BYTES: usize = 1 << 20;

/// When a pending batch is flushed to the sink.
#[derive(Debug, Clone, Copy)]
pub struct PumpConfig {
    /// A batch waits at most this long after its first line.
    pub flush_after: Duration,
    /// A batch is flushed as soon as it holds this many lines.
    pub max_batch: usize,
}

impl Default for PumpConfig {
    fn default() -> Self {
        Self {
            flush_after: Duration::from_millis(50),
            max_batch: 256,
        }
    }
}

/// Why [`read_line`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineEnd {
    /// `buf` ends with `\n`.
    Newline,
    /// `buf` holds `MAX_LINE_BYTES` and the line continues.
    Cap,
    /// The reader is exhausted; `buf` may hold a partial last line.
    Eof,
}

/// Append to `buf` up to and including the next `\n`, or until the cap or EOF. Cancel safe:
/// `fill_buf` is, and bytes are `consume`d only once they are in `buf`, so a cancelled call
/// leaves a partial line in `buf` for the next one to continue.
async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R, buf: &mut Vec<u8>) -> io::Result<LineEnd> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(LineEnd::Eof);
        }
        let room = MAX_LINE_BYTES.saturating_sub(buf.len());
        let window = &available[..available.len().min(room)];
        let (used, end) = match window.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, Some(LineEnd::Newline)),
            None => (window.len(), (window.len() == room).then_some(LineEnd::Cap)),
        };
        buf.extend_from_slice(&available[..used]);
        reader.consume(used);
        if let Some(end) = end {
            return Ok(end);
        }
    }
}

/// Take `buf` as text without its line ending, replacing invalid UTF-8.
fn take_text(buf: &mut Vec<u8>) -> String {
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    }
    let text = String::from_utf8_lossy(buf).into_owned();
    buf.clear();
    text
}

/// Forward `reader` as `Lines` batches until EOF (`Ended`) or a read error (`Error`).
pub async fn pump<R: AsyncBufRead + Unpin>(
    mut reader: R,
    session_id: u32,
    pod: &str,
    container: &str,
    cfg: PumpConfig,
    sink: &dyn LogSink,
) {
    let mut buf: Vec<u8> = Vec::new();
    let mut batch: Vec<LogLine> = Vec::new();
    let mut deadline: Option<Instant> = None;
    // Set after a cap split so the newline that closes the original line does not become
    // an empty extra line.
    let mut after_cap = false;
    let flush = |batch: &mut Vec<LogLine>, deadline: &mut Option<Instant>| {
        if !batch.is_empty() {
            sink.send(LogMessage::Lines {
                session_id,
                lines: std::mem::take(batch),
            });
        }
        *deadline = None;
    };
    // The stream stops (EOF or error) while `buf` holds an unterminated line: deliver it.
    let push_partial = |buf: &mut Vec<u8>, batch: &mut Vec<LogLine>| {
        if !buf.is_empty() {
            let text = take_text(buf);
            batch.push(LogLine {
                pod: pod.to_string(),
                container: container.to_string(),
                text,
            });
        }
    };
    loop {
        // `read_line` is cancellation safe, so racing it against the flush deadline cannot
        // lose a partial line.
        let next = match deadline {
            Some(d) => match timeout_at(d, read_line(&mut reader, &mut buf)).await {
                Ok(r) => r,
                Err(_) => {
                    flush(&mut batch, &mut deadline);
                    continue;
                }
            },
            None => read_line(&mut reader, &mut buf).await,
        };
        match next {
            Ok(end @ (LineEnd::Newline | LineEnd::Cap)) => {
                let text = take_text(&mut buf);
                let ghost = after_cap && end == LineEnd::Newline && text.is_empty();
                after_cap = end == LineEnd::Cap;
                if ghost {
                    continue;
                }
                batch.push(LogLine {
                    pod: pod.to_string(),
                    container: container.to_string(),
                    text,
                });
                if batch.len() >= cfg.max_batch {
                    flush(&mut batch, &mut deadline);
                } else if deadline.is_none() {
                    deadline = Some(Instant::now() + cfg.flush_after);
                }
            }
            Ok(LineEnd::Eof) => {
                push_partial(&mut buf, &mut batch);
                flush(&mut batch, &mut deadline);
                break;
            }
            Err(e) => {
                push_partial(&mut buf, &mut batch);
                flush(&mut batch, &mut deadline);
                sink.send(LogMessage::Error {
                    session_id,
                    pod: pod.to_string(),
                    container: container.to_string(),
                    message: e.to_string(),
                });
                return;
            }
        }
    }
    sink.send(LogMessage::Ended {
        session_id,
        pod: pod.to_string(),
        container: container.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::mpsc;

    fn cfg() -> PumpConfig {
        PumpConfig::default()
    }

    fn texts(msg: &LogMessage) -> Vec<String> {
        match msg {
            LogMessage::Lines { lines, .. } => lines.iter().map(|l| l.text.clone()).collect(),
            other => panic!("expected lines, got {other:?}"),
        }
    }

    /// A reader whose first poll fails, for the error path.
    struct Broken;
    impl tokio::io::AsyncRead for Broken {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            _: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::Error::other("reset by peer")))
        }
    }

    #[test]
    fn default_config_matches_the_spec() {
        let cfg = PumpConfig::default();
        assert_eq!(cfg.flush_after, Duration::from_millis(50));
        assert_eq!(cfg.max_batch, 256);
    }

    #[tokio::test(start_paused = true)]
    async fn lines_are_batched_by_time_then_ended_on_eof() {
        let (mut w, r) = tokio::io::duplex(4096);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move { pump(BufReader::new(r), 7, "p", "c", cfg(), &tx).await });
        w.write_all(b"one\ntwo\nthree\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        let first = rx.recv().await.unwrap();
        assert_eq!(texts(&first), ["one", "two", "three"]);
        assert!(matches!(first, LogMessage::Lines { session_id: 7, .. }));
        drop(w);
        task.await.unwrap();
        assert_eq!(
            rx.recv().await.unwrap(),
            LogMessage::Ended {
                session_id: 7,
                pod: "p".into(),
                container: "c".into()
            }
        );
        assert!(rx.recv().await.is_none(), "nothing after Ended");
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_flushes_at_max_batch_and_the_rest_on_the_timer() {
        let (mut w, r) = tokio::io::duplex(1 << 16);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move { pump(BufReader::new(r), 1, "p", "c", cfg(), &tx).await });
        let burst: String = (0..300).map(|i| format!("l{i}\n")).collect();
        w.write_all(burst.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(texts(&rx.recv().await.unwrap()).len(), 256);
        assert_eq!(texts(&rx.recv().await.unwrap()).len(), 44);
        drop(w);
        task.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_partial_last_line_is_delivered_at_eof() {
        let (mut w, r) = tokio::io::duplex(4096);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move { pump(BufReader::new(r), 3, "p", "c", cfg(), &tx).await });
        w.write_all(b"one\r\ntwo").await.unwrap();
        drop(w);
        task.await.unwrap();
        assert_eq!(texts(&rx.recv().await.unwrap()), ["one", "two"]);
        assert!(matches!(rx.recv().await.unwrap(), LogMessage::Ended { session_id: 3, .. }));
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn invalid_utf8_is_replaced_not_fatal() {
        let (mut w, r) = tokio::io::duplex(4096);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move { pump(BufReader::new(r), 4, "p", "c", cfg(), &tx).await });
        w.write_all(b"caf\xe9\nok\n").await.unwrap();
        drop(w);
        task.await.unwrap();
        assert_eq!(texts(&rx.recv().await.unwrap()), ["caf\u{FFFD}", "ok"]);
        assert!(matches!(rx.recv().await.unwrap(), LogMessage::Ended { .. }));
        assert!(rx.recv().await.is_none());
    }

    /// Pump one line of `len` x's plus `after`, and return the byte length of every emitted line.
    async fn split_lengths(len: usize) -> Vec<usize> {
        let (mut w, r) = tokio::io::duplex(1 << 16);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move { pump(BufReader::new(r), 5, "p", "c", cfg(), &tx).await });
        let mut huge = vec![b'x'; len];
        huge.push(b'\n');
        w.write_all(&huge).await.unwrap();
        w.write_all(b"after\n").await.unwrap();
        drop(w);
        task.await.unwrap();
        let mut lengths = Vec::new();
        loop {
            match rx.recv().await.unwrap() {
                LogMessage::Lines { lines, .. } => lengths.extend(lines.iter().map(|l| l.text.len())),
                LogMessage::Ended { .. } => return lengths,
                other => panic!("unexpected {other:?}"),
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_oversized_line_is_split_at_the_cap() {
        let m = MAX_LINE_BYTES;
        assert_eq!(split_lengths(2 * m + 3).await, [m, m, 3, "after".len()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_line_ending_exactly_at_the_cap_leaves_no_empty_piece() {
        let m = MAX_LINE_BYTES;
        assert_eq!(split_lengths(2 * m).await, [m, m, "after".len()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_read_error_flushes_then_reports_and_stops_without_ended() {
        let reader = BufReader::new(std::io::Cursor::new(&b"a\nb\npart"[..]).chain(Broken));
        let (tx, mut rx) = mpsc::unbounded_channel();
        pump(reader, 2, "p", "c", cfg(), &tx).await;
        // The sender lives on this stack, so drop it: only then can `recv` report the end.
        drop(tx);
        assert_eq!(
            texts(&rx.recv().await.unwrap()),
            ["a", "b", "part"],
            "pending lines and the partial line flush before the error"
        );
        match rx.recv().await.unwrap() {
            LogMessage::Error {
                session_id: 2, message, ..
            } => assert!(message.contains("reset by peer")),
            other => panic!("expected error, got {other:?}"),
        }
        assert!(rx.recv().await.is_none(), "no Ended after an error");
    }
}
