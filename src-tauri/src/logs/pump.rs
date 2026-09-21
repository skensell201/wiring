//! Reads one container's log stream line by line and forwards it in batches (spec §4: flush
//! every 50 ms or 256 lines). Generic over `AsyncBufRead` so it is tested without a cluster.

use std::time::Duration;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::time::{timeout_at, Instant};

use super::{LogLine, LogMessage, LogSink};

#[derive(Debug, Clone, Copy)]
pub struct PumpConfig {
    pub flush_after: Duration,
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

/// Forward `reader` as `Lines` batches until EOF (`Ended`) or a read error (`Error`).
pub async fn pump<R: AsyncBufRead + Unpin>(reader: R, session_id: u32, pod: &str, container: &str, cfg: PumpConfig, sink: &dyn LogSink) {
    let mut lines = reader.lines();
    let mut batch: Vec<LogLine> = Vec::new();
    let mut deadline: Option<Instant> = None;
    let flush = |batch: &mut Vec<LogLine>, deadline: &mut Option<Instant>| {
        if !batch.is_empty() {
            sink.send(LogMessage::Lines {
                session_id,
                lines: std::mem::take(batch),
            });
        }
        *deadline = None;
    };
    loop {
        // `Lines::next_line` is cancellation safe, so racing it against the flush deadline
        // cannot lose a partial line.
        let next = match deadline {
            Some(d) => match timeout_at(d, lines.next_line()).await {
                Ok(r) => r,
                Err(_) => {
                    flush(&mut batch, &mut deadline);
                    continue;
                }
            },
            None => lines.next_line().await,
        };
        match next {
            Ok(Some(text)) => {
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
            Ok(None) => {
                flush(&mut batch, &mut deadline);
                break;
            }
            Err(e) => {
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
    use crate::logs::LogMessage;
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::sync::mpsc;

    fn cfg() -> PumpConfig {
        PumpConfig {
            flush_after: Duration::from_millis(50),
            max_batch: 256,
        }
    }

    fn texts(msg: &LogMessage) -> Vec<String> {
        match msg {
            LogMessage::Lines { lines, .. } => lines.iter().map(|l| l.text.clone()).collect(),
            other => panic!("expected lines, got {other:?}"),
        }
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
    async fn a_read_error_flushes_then_reports_and_stops_without_ended() {
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
        let (tx, mut rx) = mpsc::unbounded_channel();
        pump(BufReader::new(Broken), 2, "p", "c", cfg(), &tx).await;
        // The sender lives on this stack, so drop it: only then can `recv` report the end.
        drop(tx);
        match rx.recv().await.unwrap() {
            LogMessage::Error { message, .. } => assert!(message.contains("reset by peer")),
            other => panic!("expected error, got {other:?}"),
        }
        assert!(rx.recv().await.is_none(), "no Ended after an error");
    }
}
