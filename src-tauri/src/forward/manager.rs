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

use super::{Forward, ForwardStatus, ForwardTarget};

pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

/// A byte stream to one pod port; `keep` is whatever must live as long as it (kube's Portforwarder).
pub struct Tunnel {
    pub stream: Box<dyn Duplex>,
    pub keep: Box<dyn std::any::Any + Send>,
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

fn publish(infos: &Infos, emitter: &dyn Emitter) {
    let list: Vec<Forward> = lock(infos).values().cloned().collect();
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
    pub async fn start(
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
        let listener = TcpListener::bind(("127.0.0.1", local_port)).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::AddrInUse => AppError::new(ErrorKind::Conflict, format!("port {local_port} is already in use")),
            _ => AppError::internal(format!("cannot listen on port {local_port}: {e}")),
        })?;
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        // Resolve once up front so the popover shows the pod (or why there is none) right away.
        let (pod, status, message) = match self.connector.resolve(&target, remote_port).await {
            Ok((pod, _)) => (Some(pod), ForwardStatus::Active, None),
            Err(e) => {
                let (s, m) = outcome(&e);
                (None, s, m)
            }
        };
        let info = Forward {
            id,
            node_id: node_id.to_string(),
            target_label,
            remote_port,
            local_port,
            pod,
            status,
            message,
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
    pub fn stop(&mut self, id: u32) {
        let removed = lock(&self.infos).remove(&id).is_some();
        self.tasks.remove(&id); // dropping aborts the loop, its JoinSet and the listener
        if removed {
            publish(&self.infos, &*self.emitter);
        }
    }

    pub fn stop_all(&mut self) {
        if self.tasks.is_empty() {
            return;
        }
        lock(&self.infos).clear();
        self.tasks.clear();
        publish(&self.infos, &*self.emitter);
    }

    pub fn list(&self) -> Vec<Forward> {
        lock(&self.infos).values().cloned().collect()
    }

    pub fn local_port(&self, id: u32) -> Option<u16> {
        lock(&self.infos).get(&id).map(|f| f.local_port)
    }
}

/// Accept until aborted; connections live in the JoinSet, so aborting the loop ends them too.
async fn accept_loop(listener: TcpListener, ctx: Ctx) {
    let mut conns = JoinSet::new();
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

async fn serve(mut socket: TcpStream, ctx: Ctx) {
    let tunnel = async {
        let (pod, port) = ctx.connector.resolve(&ctx.target, ctx.remote_port).await?;
        let tunnel = ctx.connector.open(&ctx.target.namespace, &pod, port).await?;
        Ok::<_, ConnectError>((pod, tunnel))
    }
    .await;
    match tunnel {
        Ok((pod, mut tunnel)) => {
            ctx.set(Some(pod), ForwardStatus::Active, None);
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut tunnel.stream).await;
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
    }

    impl Connector for Fake {
        fn resolve(&self, _: &ForwardTarget, _: u16) -> BoxFuture<'static, Result<(String, u16), ConnectError>> {
            let r = lock(&self.next).clone();
            Box::pin(async move { r })
        }
        fn open(&self, _: &str, _: &str, _: u16) -> BoxFuture<'static, Result<Tunnel, ConnectError>> {
            Box::pin(async {
                let (ours, theirs) = tokio::io::duplex(1024);
                tokio::spawn(async move {
                    let (mut r, mut w) = tokio::io::split(theirs);
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
                Ok(Tunnel {
                    stream: Box::new(ours),
                    keep: Box::new(()),
                })
            })
        }
    }

    fn manager(next: Result<(String, u16), ConnectError>) -> (ForwardManager, Arc<Fake>, tokio::sync::mpsc::UnboundedReceiver<OutEvent>) {
        let fake = Arc::new(Fake { next: Mutex::new(next) });
        let (emitter, rx) = ChannelEmitter::new();
        (ForwardManager::new(fake.clone(), Arc::new(emitter)), fake, rx)
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
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).await.unwrap();
        assert_eq!(
            (f.status, f.pod.as_deref(), f.local_port),
            (ForwardStatus::Active, Some("web-1"), port)
        );
        assert!(matches!(rx.try_recv().unwrap(), OutEvent::ForwardsChanged(list) if list.len() == 1));
        assert_eq!(&ping(port).await.unwrap(), b"ping");
        assert_eq!(m.local_port(f.id), Some(port));
    }

    #[tokio::test]
    async fn a_taken_local_port_is_a_conflict() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        let err = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict);
        assert_eq!(err.message, format!("port {port} is already in use"));
        assert!(m.list().is_empty());
    }

    #[tokio::test]
    async fn privileged_local_ports_are_invalid() {
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        assert_eq!(
            m.start("Service/ns/web", svc(), "Service web".into(), 80, 80)
                .await
                .unwrap_err()
                .kind,
            ErrorKind::Invalid
        );
    }

    #[tokio::test]
    async fn without_a_ready_pod_connections_are_closed_and_the_status_says_why() {
        let (mut m, _, _rx) = manager(Err(ConnectError::NoReadyPod));
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).await.unwrap();
        assert_eq!((f.status, f.pod), (ForwardStatus::NoReadyPod, None));
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
        m.start("Service/ns/web", svc(), "Service web".into(), 80, port).await.unwrap();
        *lock(&fake.next) = Ok(("web-2".into(), 8080));
        assert_eq!(&ping(port).await.unwrap(), b"ping");
        assert_eq!(m.list()[0].pod.as_deref(), Some("web-2"));
        let last = std::iter::from_fn(|| rx.try_recv().ok()).last().unwrap();
        assert!(matches!(last, OutEvent::ForwardsChanged(list) if list[0].pod.as_deref() == Some("web-2")));
    }

    #[tokio::test]
    async fn errors_carry_their_message() {
        let (mut m, _, _rx) = manager(Err(ConnectError::Failed("forbidden".into())));
        let f = m
            .start("Service/ns/web", svc(), "Service web".into(), 80, free_port())
            .await
            .unwrap();
        assert_eq!((f.status, f.message.as_deref()), (ForwardStatus::Error, Some("forbidden")));
    }

    #[tokio::test]
    async fn stop_closes_the_port_and_stop_all_empties_the_list() {
        let (mut m, _, mut rx) = manager(Ok(("web-1".into(), 8080)));
        let (a, b) = (free_port(), free_port());
        let fa = m.start("Service/ns/web", svc(), "Service web".into(), 80, a).await.unwrap();
        m.start("Service/ns/web", svc(), "Service web".into(), 80, b).await.unwrap();
        m.stop(fa.id);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while matches!(tokio::time::timeout(WAIT, TcpStream::connect(("127.0.0.1", a))).await, Ok(Ok(_))) {
            assert!(tokio::time::Instant::now() < deadline, "port {a} still open after stop");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(m.list().len(), 1);
        m.stop_all();
        assert!(m.list().is_empty());
        let last = std::iter::from_fn(|| rx.try_recv().ok()).last().unwrap();
        assert_eq!(last, OutEvent::ForwardsChanged(vec![]));
    }
}
