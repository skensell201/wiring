//! Live exec sessions: per terminal, a task that opens the connection, then pumps stdout to the
//! sink and the input queue to stdin (spec §4). Owned by the namespace `Session`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::session::watch::AbortOnDrop;

use super::{encode_output, errors, ClosableExecSink, ExecMessage, ExecSink};

/// Bounds opening the websocket (a hung API server must not leave "connecting…" forever).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long to wait for the exit status once the output has ended.
pub const STATUS_WAIT: Duration = Duration::from_secs(2);
pub const TIMED_OUT: &str = "timed out connecting to the container";
const READ_CHUNK: usize = 16 * 1024;

pub type Resize = Box<dyn FnMut(u16, u16) + Send>;

/// A started remote process as the session needs it: the kube `AttachedProcess` in the app, a
/// pair of in-memory pipes in the tests.
pub struct Process {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub resize: Resize,
    pub status: BoxFuture<'static, Option<Status>>,
    /// Owns the connection; dropping it closes the websocket.
    pub keep: Box<dyn Send>,
}

pub trait ExecConnector: Send + Sync + 'static {
    /// Open a TTY shell in `pod`/`container` sized `cols`×`rows`; the error is a user message.
    fn open(&self, namespace: &str, pod: &str, container: &str, cols: u16, rows: u16) -> BoxFuture<'static, Result<Process, String>>;
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub node_id: String,
    pub pod: String,
    pub container: String,
    pub cols: u16,
    pub rows: u16,
}

enum Input {
    Data(Vec<u8>),
    Resize(u16, u16),
}

struct Live {
    input: mpsc::UnboundedSender<Input>,
    sink: Arc<ClosableExecSink>,
    task: AbortOnDrop,
}

pub struct ExecSessions {
    connector: Arc<dyn ExecConnector>,
    live: HashMap<u32, Live>,
    next_id: u32,
}

impl ExecSessions {
    pub fn new(connector: Arc<dyn ExecConnector>) -> Self {
        Self {
            connector,
            live: HashMap::new(),
            next_id: 1,
        }
    }

    /// Start a session for an already-validated request (see `targets::check_target`). Returns
    /// at once; connect failures arrive as `error` messages.
    pub fn start(&mut self, namespace: String, req: ExecRequest, sink: Arc<dyn ExecSink>) -> u32 {
        self.live.retain(|_, l| !l.task.0.is_finished());
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let sink = Arc::new(ClosableExecSink::new(sink));
        let (tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(session_task(id, self.connector.clone(), namespace, req, sink.clone(), rx));
        self.live.insert(
            id,
            Live {
                input: tx,
                sink,
                task: AbortOnDrop(task),
            },
        );
        id
    }

    /// Whether the session is known and its task still runs (a session whose sink failed has
    /// ended on its own and is pruned on the next `start`).
    pub fn is_active(&self, id: u32) -> bool {
        self.live.get(&id).is_some_and(|l| !l.task.0.is_finished())
    }

    /// Queue keystrokes (also while still connecting). Unknown ids are a no-op.
    pub fn input(&self, id: u32, data: Vec<u8>) {
        if let Some(live) = self.live.get(&id) {
            let _ = live.input.send(Input::Data(data));
        }
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        if let Some(live) = self.live.get(&id) {
            let _ = live.input.send(Input::Resize(cols, rows));
        }
    }

    /// Nothing reaches the sink once this returns, and the session task (with its connection) is
    /// gone: the task is aborted and awaited.
    pub async fn stop(&mut self, id: u32) {
        if let Some(live) = self.live.remove(&id) {
            live.sink.close();
            abort_and_wait(live.task).await;
        }
    }

    pub async fn stop_all(&mut self) {
        let all: Vec<Live> = self.live.drain().map(|(_, l)| l).collect();
        for live in &all {
            live.sink.close();
            live.task.0.abort();
        }
        for live in all {
            abort_and_wait(live.task).await;
        }
    }
}

async fn abort_and_wait(mut task: AbortOnDrop) {
    task.0.abort();
    let _ = (&mut task.0).await;
}

async fn session_task(
    id: u32,
    connector: Arc<dyn ExecConnector>,
    namespace: String,
    req: ExecRequest,
    sink: Arc<ClosableExecSink>,
    input: mpsc::UnboundedReceiver<Input>,
) {
    let opening = connector.open(&namespace, &req.pod, &req.container, req.cols, req.rows);
    let process = match tokio::time::timeout(CONNECT_TIMEOUT, opening).await {
        Ok(Ok(process)) => process,
        Ok(Err(message)) => {
            sink.send(ExecMessage::Error { session_id: id, message });
            return;
        }
        Err(_) => {
            sink.send(ExecMessage::Error {
                session_id: id,
                message: TIMED_OUT.into(),
            });
            return;
        }
    };
    pump(id, process, sink, input).await;
}

async fn pump(id: u32, mut p: Process, sink: Arc<ClosableExecSink>, mut input: mpsc::UnboundedReceiver<Input>) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        tokio::select! {
            read = p.stdout.read(&mut buf) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if !sink.send(ExecMessage::Output { session_id: id, data: encode_output(&buf[..n]) }) {
                        // The frontend is gone: drop the process so the remote shell gets a hangup.
                        return;
                    }
                }
            },
            msg = input.recv() => match msg {
                Some(Input::Data(bytes)) => {
                    if p.stdin.write_all(&bytes).await.is_err() || p.stdin.flush().await.is_err() {
                        break;
                    }
                }
                Some(Input::Resize(cols, rows)) => (p.resize)(cols, rows),
                // The session was stopped: its sink is closed, nothing more to say.
                None => return,
            },
        }
    }
    let status = tokio::time::timeout(STATUS_WAIT, p.status).await.ok().flatten();
    let (code, message) = errors::ended(status.as_ref());
    sink.send(ExecMessage::Ended {
        session_id: id,
        code,
        message,
    });
    drop(p.keep);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::ExecMessage;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use futures::FutureExt;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
    use tokio::sync::{mpsc, oneshot};

    #[derive(Clone)]
    enum Behaviour {
        Open,
        Fail(String),
        Hang,
    }

    /// The test's side of one fake process.
    struct Ends {
        stdout: DuplexStream,
        stdin: DuplexStream,
        resizes: Arc<Mutex<Vec<(u16, u16)>>>,
        status: oneshot::Sender<Option<Status>>,
        dropped: Arc<AtomicBool>,
        size: (u16, u16),
    }

    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    struct Fake {
        behaviour: Behaviour,
        ends: mpsc::UnboundedSender<Ends>,
    }

    impl ExecConnector for Fake {
        fn open(&self, _ns: &str, _pod: &str, _container: &str, cols: u16, rows: u16) -> BoxFuture<'static, Result<Process, String>> {
            let behaviour = self.behaviour.clone();
            let ends = self.ends.clone();
            async move {
                match behaviour {
                    Behaviour::Fail(m) => return Err(m),
                    Behaviour::Hang => futures::future::pending::<()>().await,
                    Behaviour::Open => {}
                }
                let (stdout_remote, stdout_test) = tokio::io::duplex(1024);
                let (stdin_remote, stdin_test) = tokio::io::duplex(1024);
                let resizes = Arc::new(Mutex::new(Vec::new()));
                let (status_tx, status_rx) = oneshot::channel();
                let dropped = Arc::new(AtomicBool::new(false));
                let seen = resizes.clone();
                ends.send(Ends {
                    stdout: stdout_test,
                    stdin: stdin_test,
                    resizes,
                    status: status_tx,
                    dropped: dropped.clone(),
                    size: (cols, rows),
                })
                .unwrap();
                Ok(Process {
                    stdin: Box::new(stdin_remote),
                    stdout: Box::new(stdout_remote),
                    resize: Box::new(move |c, r| seen.lock().unwrap().push((c, r))),
                    status: Box::pin(async move { status_rx.await.ok().flatten() }),
                    keep: Box::new(DropFlag(dropped)),
                })
            }
            .boxed()
        }
    }

    fn setup(
        behaviour: Behaviour,
    ) -> (
        ExecSessions,
        mpsc::UnboundedReceiver<Ends>,
        mpsc::UnboundedReceiver<ExecMessage>,
        u32,
    ) {
        let (ends_tx, ends_rx) = mpsc::unbounded_channel();
        let mut sessions = ExecSessions::new(Arc::new(Fake { behaviour, ends: ends_tx }));
        let (tx, rx) = mpsc::unbounded_channel();
        let req = ExecRequest {
            node_id: "Pod/shop/solo".into(),
            pod: "solo".into(),
            container: "main".into(),
            cols: 80,
            rows: 24,
        };
        let id = sessions.start("shop".into(), req, Arc::new(tx));
        (sessions, ends_rx, rx, id)
    }

    async fn next<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("in time")
            .expect("open")
    }

    fn exit_status(code: i32) -> Status {
        Status {
            status: Some("Failure".into()),
            details: Some(StatusDetails {
                causes: Some(vec![StatusCause {
                    reason: Some("ExitCode".into()),
                    message: Some(code.to_string()),
                    field: None,
                }]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn output_is_forwarded_as_base64_with_the_initial_size() {
        let (_s, mut ends_rx, mut rx, id) = setup(Behaviour::Open);
        let mut ends = next(&mut ends_rx).await;
        assert_eq!(ends.size, (80, 24));
        ends.stdout.write_all(b"hi \x1b[31mred").await.unwrap();
        match next(&mut rx).await {
            ExecMessage::Output { session_id, data } => {
                assert_eq!(session_id, id);
                assert_eq!(STANDARD.decode(data).unwrap(), b"hi \x1b[31mred");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn input_and_resize_reach_the_process() {
        let (s, mut ends_rx, _rx, id) = setup(Behaviour::Open);
        let mut ends = next(&mut ends_rx).await;
        s.input(id, b"ls\n".to_vec());
        let mut buf = [0u8; 3];
        tokio::time::timeout(Duration::from_secs(5), ends.stdin.read_exact(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&buf, b"ls\n");
        // The queue is ordered: once the input sent after the resize has arrived, so has the resize.
        s.resize(id, 120, 40);
        s.input(id, b"!".to_vec());
        let mut mark = [0u8; 1];
        tokio::time::timeout(Duration::from_secs(5), ends.stdin.read_exact(&mut mark))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ends.resizes.lock().unwrap().as_slice(), &[(120, 40)]);
    }

    #[tokio::test]
    async fn the_end_of_output_reports_the_exit_code() {
        let (_s, mut ends_rx, mut rx, id) = setup(Behaviour::Open);
        let ends = next(&mut ends_rx).await;
        ends.status.send(Some(exit_status(3))).unwrap();
        drop(ends.stdout);
        assert_eq!(
            next(&mut rx).await,
            ExecMessage::Ended {
                session_id: id,
                code: Some(3),
                message: None
            }
        );
    }

    #[tokio::test]
    async fn a_failed_connect_is_an_error_message() {
        let (_s, _ends_rx, mut rx, id) = setup(Behaviour::Fail("No permission to exec into pods (pods/exec)".into()));
        assert_eq!(
            next(&mut rx).await,
            ExecMessage::Error {
                session_id: id,
                message: "No permission to exec into pods (pods/exec)".into()
            }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_hanging_connect_times_out() {
        let (_s, _ends_rx, mut rx, id) = setup(Behaviour::Hang);
        let msg = tokio::time::timeout(CONNECT_TIMEOUT * 2, rx.recv())
            .await
            .expect("in time")
            .expect("open");
        assert_eq!(
            msg,
            ExecMessage::Error {
                session_id: id,
                message: TIMED_OUT.into()
            }
        );
    }

    #[tokio::test]
    async fn stop_silences_the_session_and_drops_the_connection() {
        let (mut s, mut ends_rx, mut rx, id) = setup(Behaviour::Open);
        let mut ends = next(&mut ends_rx).await;
        s.stop(id).await;
        let _ = ends.stdout.write_all(b"late").await;
        assert!(ends.dropped.load(Ordering::SeqCst), "the process was not dropped");
        assert!(rx.try_recv().is_err(), "nothing may arrive after stop");
        s.input(id, b"x".to_vec()); // unknown id now: a no-op
    }

    #[tokio::test]
    async fn stop_all_ends_every_session() {
        let (mut s, mut ends_rx, _rx, _id) = setup(Behaviour::Open);
        let (tx2, _rx2) = mpsc::unbounded_channel();
        let req = ExecRequest {
            node_id: "Pod/shop/solo".into(),
            pod: "solo".into(),
            container: "main".into(),
            cols: 80,
            rows: 24,
        };
        s.start("shop".into(), req, Arc::new(tx2));
        let a = next(&mut ends_rx).await;
        let b = next(&mut ends_rx).await;
        s.stop_all().await;
        assert!(
            a.dropped.load(Ordering::SeqCst) && b.dropped.load(Ordering::SeqCst),
            "sessions survived stop_all"
        );
    }

    /// Delivers the first `left` messages (mirrored to `seen`), then refuses like a gone webview.
    struct FailsAfter {
        left: std::sync::atomic::AtomicUsize,
        seen: mpsc::UnboundedSender<ExecMessage>,
    }

    impl ExecSink for FailsAfter {
        fn send(&self, msg: ExecMessage) -> bool {
            let ok = self
                .left
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok();
            if ok {
                let _ = self.seen.send(msg);
            }
            ok
        }
    }

    #[tokio::test]
    async fn a_failing_sink_ends_the_session_and_drops_the_process() {
        let (ends_tx, mut ends_rx) = mpsc::unbounded_channel();
        let mut sessions = ExecSessions::new(Arc::new(Fake {
            behaviour: Behaviour::Open,
            ends: ends_tx,
        }));
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
        let sink = Arc::new(FailsAfter {
            left: std::sync::atomic::AtomicUsize::new(1),
            seen: seen_tx,
        });
        let req = ExecRequest {
            node_id: "Pod/shop/solo".into(),
            pod: "solo".into(),
            container: "main".into(),
            cols: 80,
            rows: 24,
        };
        let id = sessions.start("shop".into(), req, sink);
        let mut ends = next(&mut ends_rx).await;
        ends.stdout.write_all(b"one").await.unwrap();
        assert!(matches!(next(&mut seen_rx).await, ExecMessage::Output { .. })); // delivered
        ends.stdout.write_all(b"two").await.unwrap(); // refused: the frontend is gone
                                                      // The process is dropped, so its stdin sees EOF.
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), ends.stdin.read_to_end(&mut rest))
            .await
            .expect("in time")
            .unwrap();
        assert!(ends.dropped.load(Ordering::SeqCst));
        assert!(seen_rx.try_recv().is_err(), "no Ended after a failed send");
        // The task finishes right after dropping the process.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while sessions.is_active(id) {
            assert!(tokio::time::Instant::now() < deadline, "the session never ended");
            tokio::task::yield_now().await;
        }
        sessions.stop(id).await; // still safe
        assert!(!sessions.is_active(id));
    }
}
