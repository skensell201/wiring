//! One TCP accept loop per forward; every accepted connection resolves its pod at that moment
//! and gets its own tunnel, which is what makes Service/workload forwards follow restarts.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::session::emitter::{Emitter, OutEvent};
use crate::session::watch::AbortOnDrop;

use super::{bind_loopback, BindError, Forward, ForwardStatus, ForwardTarget};

pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

/// A byte stream to one pod port; `keep` is whatever must live as long as it (kube's Portforwarder).
pub struct Tunnel {
    pub stream: Box<dyn Duplex>,
    pub keep: Box<dyn std::any::Any + Send>,
    /// Resolves with the error the kubelet reported on this stream, if any (e.g. nothing
    /// listens on the pod port); awaited after the stream ends.
    pub error: Option<BoxFuture<'static, Option<String>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    NoReadyPod,
    PodGone,
    Failed(String),
}

/// The cluster side of a forward; the tests use an in-memory fake.
pub trait Connector: Send + Sync + 'static {
    /// The pod (name, port) a new connection to `target:remote_port` should reach now.
    fn resolve(&self, target: &ForwardTarget, remote_port: u16) -> BoxFuture<'static, Result<(String, u16), ConnectError>>;
    fn open(&self, namespace: &str, pod: &str, port: u16) -> BoxFuture<'static, Result<Tunnel, ConnectError>>;
}

type Infos = Arc<Mutex<BTreeMap<u32, Forward>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Snapshot and emit under one lock hold: emitters only queue the event (a channel send or a
/// Tauri emit), so lists reach the frontend in the order of the states they describe and a stale
/// one cannot overtake a newer one. Emitters must not call back into the manager.
fn publish(infos: &Infos, emitter: &dyn Emitter) {
    let guard = lock(infos);
    let list: Vec<Forward> = guard.values().cloned().collect();
    emitter.emit(OutEvent::ForwardsChanged(list));
}

fn outcome(e: &ConnectError) -> (ForwardStatus, Option<String>) {
    match e {
        ConnectError::NoReadyPod => (ForwardStatus::NoReadyPod, None),
        ConnectError::PodGone => (ForwardStatus::PodGone, None),
        ConnectError::Failed(m) => (ForwardStatus::Error, Some(m.clone())),
    }
}

/// What one forward's accept loop and its connections share.
#[derive(Clone)]
struct Ctx {
    id: u32,
    target: ForwardTarget,
    remote_port: u16,
    connector: Arc<dyn Connector>,
    infos: Infos,
    emitter: Arc<dyn Emitter>,
}

impl Ctx {
    /// Record the latest connection attempt; emits only when something visible changed.
    fn set(&self, pod: Option<String>, status: ForwardStatus, message: Option<String>) {
        let changed = {
            let mut map = lock(&self.infos);
            match map.get_mut(&self.id) {
                Some(f) if f.pod != pod || f.status != status || f.message != message => {
                    f.pod = pod;
                    f.status = status;
                    f.message = message;
                    true
                }
                _ => false,
            }
        };
        if changed {
            publish(&self.infos, &*self.emitter);
        }
    }
}

/// The forwards of one connection. Dropping it (with the Session) closes every port.
pub struct ForwardManager {
    connector: Arc<dyn Connector>,
    emitter: Arc<dyn Emitter>,
    infos: Infos,
    tasks: HashMap<u32, AbortOnDrop>,
    next_id: u32,
}

impl ForwardManager {
    pub fn new(connector: Arc<dyn Connector>, emitter: Arc<dyn Emitter>) -> Self {
        Self {
            connector,
            emitter,
            infos: Arc::default(),
            tasks: HashMap::new(),
            next_id: 1,
        }
    }

    /// Bind `127.0.0.1:local_port` and start forwarding it to `target:remote_port`.
    /// Returns at once (the caller holds the session lock): the accept task makes the first
    /// resolve itself and reports the pod, or why there is none, through `forwards_changed`.
    pub fn start(
        &mut self,
        node_id: &str,
        target: ForwardTarget,
        target_label: String,
        remote_port: u16,
        local_port: u16,
    ) -> AppResult<Forward> {
        if local_port < 1024 {
            return Err(AppError::new(ErrorKind::Invalid, "the local port must be between 1024 and 65535"));
        }
        let listener = listen(local_port)?;
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        let info = Forward {
            id,
            node_id: node_id.to_string(),
            target_label,
            remote_port,
            local_port,
            pod: None,
            status: ForwardStatus::Active,
            message: None,
        };
        lock(&self.infos).insert(id, info.clone());
        publish(&self.infos, &*self.emitter);
        let ctx = Ctx {
            id,
            target,
            remote_port,
            connector: self.connector.clone(),
            infos: self.infos.clone(),
            emitter: self.emitter.clone(),
        };
        self.tasks.insert(id, AbortOnDrop(tokio::spawn(accept_loop(listener, ctx))));
        Ok(info)
    }

    /// Close the port and its connections; unknown ids are a no-op.
    /// Returns once the accept loop is gone, so the port can be bound again immediately.
    pub async fn stop(&mut self, id: u32) {
        let removed = lock(&self.infos).remove(&id).is_some();
        if let Some(task) = self.tasks.remove(&id) {
            abort_and_wait(task).await; // ends the loop, its JoinSet and the listener
        }
        if removed {
            publish(&self.infos, &*self.emitter);
        }
    }

    pub async fn stop_all(&mut self) {
        if self.tasks.is_empty() {
            return;
        }
        lock(&self.infos).clear();
        let tasks: Vec<_> = self.tasks.drain().map(|(_, t)| t).collect();
        for t in &tasks {
            t.0.abort();
        }
        for t in tasks {
            abort_and_wait(t).await;
        }
        publish(&self.infos, &*self.emitter);
    }

    pub fn list(&self) -> Vec<Forward> {
        lock(&self.infos).values().cloned().collect()
    }

    pub fn local_port(&self, id: u32) -> Option<u16> {
        lock(&self.infos).get(&id).map(|f| f.local_port)
    }
}

async fn abort_and_wait(mut task: AbortOnDrop) {
    task.0.abort();
    let _ = (&mut task.0).await;
}

fn listen(port: u16) -> AppResult<TcpListener> {
    let in_use = || AppError::new(ErrorKind::Conflict, format!("port {port} is already in use"));
    let cannot = |e: std::io::Error| AppError::internal(format!("cannot listen on port {port}: {e}"));
    let socket = bind_loopback(port).map_err(|e| match e {
        BindError::InUse => in_use(),
        BindError::Other(e) => cannot(e),
    })?;
    socket.listen(1024).map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => in_use(),
        _ => cannot(e),
    })
}

/// Bound for each resolve/open so a stalled API server cannot wedge a connection or `start`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

async fn with_timeout<T>(fut: impl std::future::Future<Output = Result<T, ConnectError>>) -> Result<T, ConnectError> {
    tokio::time::timeout(CONNECT_TIMEOUT, fut)
        .await
        .unwrap_or_else(|_| Err(ConnectError::Failed("timed out".into())))
}

/// Accept until aborted; connections live in the JoinSet, so aborting the loop ends them too.
async fn accept_loop(listener: TcpListener, ctx: Ctx) {
    let mut conns = JoinSet::new();
    conns.spawn(first_resolve(ctx.clone()));
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    conns.spawn(serve(socket, ctx.clone()));
                }
                // e.g. out of file descriptors: back off instead of spinning
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
        }
    }
}

/// The status right after `start`, before any connection: the pod, or why there is none.
async fn first_resolve(ctx: Ctx) {
    match with_timeout(ctx.connector.resolve(&ctx.target, ctx.remote_port)).await {
        Ok((pod, _)) => ctx.set(Some(pod), ForwardStatus::Active, None),
        Err(e) => {
            let (status, message) = outcome(&e);
            ctx.set(None, status, message);
        }
    }
}

async fn serve(mut socket: TcpStream, ctx: Ctx) {
    let tunnel = async {
        let (pod, port) = with_timeout(ctx.connector.resolve(&ctx.target, ctx.remote_port)).await?;
        let tunnel = with_timeout(ctx.connector.open(&ctx.target.namespace, &pod, port)).await?;
        Ok::<_, ConnectError>((pod, tunnel))
    }
    .await;
    match tunnel {
        Ok((pod, mut tunnel)) => {
            ctx.set(Some(pod.clone()), ForwardStatus::Active, None);
            // A mid-stream failure just ends this connection: the status only changes on
            // connection attempts, not while one is running.
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut tunnel.stream).await;
            if let Some(error) = tunnel.error.take() {
                if let Ok(Some(message)) = tokio::time::timeout(Duration::from_secs(2), error).await {
                    ctx.set(Some(pod), ForwardStatus::Error, Some(message));
                }
            }
        }
        // Dropping `socket` closes the client's connection.
        Err(e) => {
            let (status, message) = outcome(&e);
            ctx.set(None, status, message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::emitter::ChannelEmitter;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Resolves to whatever `next` holds; `open` returns an in-memory echo tunnel.
    struct Fake {
        next: Mutex<Result<(String, u16), ConnectError>>,
        hang: std::sync::atomic::AtomicBool,
        /// resolve blocks until this is notified
        gate: Option<Arc<tokio::sync::Notify>>,
        /// kubelet error reported by every tunnel
        stream_error: Option<String>,
    }

    impl Connector for Fake {
        fn resolve(&self, _: &ForwardTarget, _: u16) -> BoxFuture<'static, Result<(String, u16), ConnectError>> {
            let r = lock(&self.next).clone();
            let hang = self.hang.load(std::sync::atomic::Ordering::SeqCst);
            let gate = self.gate.clone();
            Box::pin(async move {
                if let Some(g) = gate {
                    g.notified().await;
                }
                if hang {
                    std::future::pending::<()>().await;
                }
                r
            })
        }
        fn open(&self, _: &str, _: &str, _: u16) -> BoxFuture<'static, Result<Tunnel, ConnectError>> {
            let err = self.stream_error.clone();
            Box::pin(async move {
                let (ours, theirs) = tokio::io::duplex(1024);
                tokio::spawn(async move {
                    let (mut r, mut w) = tokio::io::split(theirs);
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
                Ok(Tunnel {
                    stream: Box::new(ours),
                    keep: Box::new(()),
                    error: err.map(|m| Box::pin(async move { Some(m) }) as BoxFuture<'static, Option<String>>),
                })
            })
        }
    }

    fn manager(next: Result<(String, u16), ConnectError>) -> (ForwardManager, Arc<Fake>, tokio::sync::mpsc::UnboundedReceiver<OutEvent>) {
        let fake = Arc::new(Fake {
            next: Mutex::new(next),
            hang: Default::default(),
            gate: None,
            stream_error: None,
        });
        let (emitter, rx) = ChannelEmitter::new();
        (ForwardManager::new(fake.clone(), Arc::new(emitter)), fake, rx)
    }

    fn manager_with(fake: Fake) -> (ForwardManager, tokio::sync::mpsc::UnboundedReceiver<OutEvent>) {
        let (emitter, rx) = ChannelEmitter::new();
        (ForwardManager::new(Arc::new(fake), Arc::new(emitter)), rx)
    }

    /// Poll until the forward satisfies `pred` (the accept task reports asynchronously).
    async fn wait_for(m: &ForwardManager, id: u32, pred: impl Fn(&Forward) -> bool) -> Forward {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            if let Some(f) = m.list().into_iter().find(|f| f.id == id).filter(|f| pred(f)) {
                return f;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "forward {id} never reached the expected state"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn svc() -> ForwardTarget {
        ForwardTarget {
            kind: crate::store::Kind::Service,
            namespace: "ns".into(),
            name: "web".into(),
        }
    }

    const WAIT: Duration = Duration::from_secs(5);

    async fn ping(port: u16) -> std::io::Result<[u8; 4]> {
        let io = async {
            let mut c = TcpStream::connect(("127.0.0.1", port)).await?;
            c.write_all(b"ping").await?;
            let mut buf = [0u8; 4];
            c.read_exact(&mut buf).await?;
            Ok(buf)
        };
        tokio::time::timeout(WAIT, io).await.expect("ping timed out")
    }

    #[tokio::test]
    async fn a_forward_tunnels_bytes_and_reports_its_pod() {
        let (mut m, _, mut rx) = manager(Ok(("web-1".into(), 8080)));
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap();
        assert_eq!((f.status, f.pod.as_deref(), f.local_port), (ForwardStatus::Active, None, port));
        assert!(matches!(rx.try_recv().unwrap(), OutEvent::ForwardsChanged(list) if list.len() == 1));
        assert_eq!(wait_for(&m, f.id, |f| f.pod.is_some()).await.pod.as_deref(), Some("web-1"));
        assert_eq!(&ping(port).await.unwrap(), b"ping");
        assert_eq!(m.local_port(f.id), Some(port));
    }

    #[tokio::test]
    async fn a_taken_local_port_is_a_conflict() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        let err = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict);
        assert_eq!(err.message, format!("port {port} is already in use"));
        assert!(m.list().is_empty());
    }

    #[tokio::test]
    async fn privileged_local_ports_are_invalid() {
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        assert_eq!(
            m.start("Service/ns/web", svc(), "Service web".into(), 80, 80).unwrap_err().kind,
            ErrorKind::Invalid
        );
    }

    #[tokio::test]
    async fn without_a_ready_pod_connections_are_closed_and_the_status_says_why() {
        let (mut m, _, _rx) = manager(Err(ConnectError::NoReadyPod));
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap();
        let f = wait_for(&m, f.id, |f| f.status == ForwardStatus::NoReadyPod).await;
        assert_eq!(f.pod, None);
        let mut c = tokio::time::timeout(WAIT, TcpStream::connect(("127.0.0.1", port)))
            .await
            .expect("connect timed out")
            .unwrap();
        let mut buf = [0u8; 1];
        let n = tokio::time::timeout(WAIT, c.read(&mut buf)).await.expect("read timed out").unwrap();
        assert_eq!(n, 0, "the connection is closed");
    }

    #[tokio::test]
    async fn each_connection_reselects_the_pod() {
        let (mut m, fake, mut rx) = manager(Ok(("web-1".into(), 8080)));
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap();
        wait_for(&m, f.id, |f| f.pod.as_deref() == Some("web-1")).await;
        *lock(&fake.next) = Ok(("web-2".into(), 8080));
        assert_eq!(&ping(port).await.unwrap(), b"ping");
        assert_eq!(m.list()[0].pod.as_deref(), Some("web-2"));
        let last = std::iter::from_fn(|| rx.try_recv().ok()).last().unwrap();
        assert!(matches!(last, OutEvent::ForwardsChanged(list) if list[0].pod.as_deref() == Some("web-2")));
    }

    #[tokio::test]
    async fn errors_carry_their_message() {
        let (mut m, _, _rx) = manager(Err(ConnectError::Failed("forbidden".into())));
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, free_port()).unwrap();
        let f = wait_for(&m, f.id, |f| f.status == ForwardStatus::Error).await;
        assert_eq!(f.message.as_deref(), Some("forbidden"));
    }

    #[tokio::test]
    async fn stop_closes_the_port_and_stop_all_empties_the_list() {
        let (mut m, _, mut rx) = manager(Ok(("web-1".into(), 8080)));
        let (a, b) = (free_port(), free_port());
        let fa = m.start("Service/ns/web", svc(), "Service web".into(), 80, a).unwrap();
        m.start("Service/ns/web", svc(), "Service web".into(), 80, b).unwrap();
        m.stop(fa.id).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while matches!(tokio::time::timeout(WAIT, TcpStream::connect(("127.0.0.1", a))).await, Ok(Ok(_))) {
            assert!(tokio::time::Instant::now() < deadline, "port {a} still open after stop");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(m.list().len(), 1);
        m.stop_all().await;
        assert!(m.list().is_empty());
        let last = std::iter::from_fn(|| rx.try_recv().ok()).last().unwrap();
        assert_eq!(last, OutEvent::ForwardsChanged(vec![]));
    }

    #[tokio::test]
    async fn a_wildcard_listener_on_the_port_is_a_conflict() {
        let taken = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        let err = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict);
        assert_eq!(err.message, format!("port {port} is already in use"));
    }

    #[tokio::test]
    async fn stop_closes_a_live_connection() {
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap();
        let mut c = tokio::time::timeout(WAIT, TcpStream::connect(("127.0.0.1", port)))
            .await
            .expect("connect timed out")
            .unwrap();
        tokio::time::timeout(WAIT, c.write_all(b"ping"))
            .await
            .expect("write timed out")
            .unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(WAIT, c.read_exact(&mut buf))
            .await
            .expect("read timed out")
            .unwrap();
        m.stop(f.id).await;
        let r = tokio::time::timeout(Duration::from_secs(2), c.read(&mut buf))
            .await
            .expect("connection still open after stop");
        assert!(matches!(r, Ok(0) | Err(_)));
    }

    #[tokio::test]
    async fn a_port_can_be_reused_right_after_stop() {
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap();
        m.stop(f.id).await;
        m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap();
        assert_eq!(&ping(port).await.unwrap(), b"ping");
    }

    #[tokio::test]
    async fn a_port_with_closed_connections_can_be_reused_right_after_stop() {
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap();
        // The client stays connected while we stop, so our side closes first and holds TIME_WAIT.
        let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        c.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(WAIT, c.read_exact(&mut buf))
            .await
            .expect("read timed out")
            .unwrap();
        m.stop(f.id).await;
        m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap();
        assert_eq!(&ping(port).await.unwrap(), b"ping");
        drop(c);
    }

    /// Records the lists it is given in arrival order; a list with a resolved pod takes a while to deliver.
    struct SlowEmitter(Arc<Mutex<Vec<Vec<Forward>>>>);
    impl Emitter for SlowEmitter {
        fn emit(&self, event: OutEvent) {
            if let OutEvent::ForwardsChanged(list) = event {
                if list.iter().any(|f| f.pod.is_some()) {
                    std::thread::sleep(Duration::from_millis(200));
                }
                lock(&self.0).push(list);
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stale_list_is_never_emitted_after_stops() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let fake = Arc::new(Fake {
            next: Mutex::new(Ok(("web-1".into(), 8080))),
            hang: Default::default(),
            gate: None,
            stream_error: None,
        });
        let mut m = ForwardManager::new(fake, Arc::new(SlowEmitter(seen.clone())));
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, free_port()).unwrap();
        // The first resolve is now mid-delivery of its "pod resolved" list.
        tokio::time::sleep(Duration::from_millis(60)).await;
        m.stop(f.id).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        let seen = lock(&seen);
        assert_eq!(seen.last(), Some(&vec![]), "{seen:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_hanging_resolve_times_out_without_blocking_start() {
        let (mut m, fake, _rx) = manager(Ok(("web-1".into(), 8080)));
        fake.hang.store(true, std::sync::atomic::Ordering::SeqCst);
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, free_port()).unwrap();
        assert_eq!(f.status, ForwardStatus::Active);
        tokio::time::sleep(CONNECT_TIMEOUT + Duration::from_secs(1)).await;
        let f = wait_for(&m, f.id, |f| f.status == ForwardStatus::Error).await;
        assert_eq!(f.message.as_deref(), Some("timed out"));
    }

    #[tokio::test]
    async fn start_returns_before_the_first_resolve_finishes() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let (mut m, _rx) = manager_with(Fake {
            next: Mutex::new(Ok(("web-1".into(), 8080))),
            hang: Default::default(),
            gate: Some(gate.clone()),
            stream_error: None,
        });
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, free_port()).unwrap();
        assert_eq!((f.status, f.pod), (ForwardStatus::Active, None));
        assert_eq!(m.list()[0].pod, None, "still unresolved while the gate is closed");
        gate.notify_one();
        wait_for(&m, f.id, |f| f.pod.as_deref() == Some("web-1")).await;
    }

    #[tokio::test]
    async fn a_kubelet_error_on_the_stream_becomes_the_status() {
        let (mut m, _rx) = manager_with(Fake {
            next: Mutex::new(Ok(("web-1".into(), 8080))),
            hang: Default::default(),
            gate: None,
            stream_error: Some("connection refused".into()),
        });
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).unwrap();
        assert_eq!(&ping(port).await.unwrap(), b"ping");
        let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        c.shutdown().await.unwrap();
        let f = wait_for(&m, f.id, |f| f.status == ForwardStatus::Error).await;
        assert_eq!(f.message.as_deref(), Some("connection refused"));
    }
}
