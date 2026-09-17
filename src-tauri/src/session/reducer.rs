//! Consumes StoreEvents, keeps the Store and last Graph, emits snapshots/deltas.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::emitter::{ConnectionState, Emitter, OutEvent};
use super::watch::StoreEvent;
use crate::error::AppError;
use crate::graph::{build, diff, BuildOptions, Graph, NodeId};
use crate::store::{Kind, Object, ObjectKey, Store};

// `StoreEvent` carries a full k8s-openapi `Object` (see watch.rs); event volume is bounded
// by watcher throughput, so boxing here would only add indirection without a real benefit.
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum ReducerMsg {
    Store(StoreEvent),
    /// Options changed (expanded groups) — rebuild now.
    Rebuild,
}

#[derive(Debug, Clone)]
pub struct ReducerConfig {
    pub kinds: Vec<Kind>,
    pub debounce: Duration,
    pub degraded_after: Duration,
    pub tick: Duration,
}

impl Default for ReducerConfig {
    fn default() -> Self {
        Self {
            kinds: Kind::WATCHED.to_vec(),
            debounce: Duration::from_millis(150),
            degraded_after: Duration::from_secs(30),
            tick: Duration::from_secs(5),
        }
    }
}

/// State shared between the reducer task and `Session` (for get_object etc.).
#[derive(Default, Clone)]
pub struct Shared {
    pub store: Arc<Mutex<Store>>,
    pub graph: Arc<Mutex<Graph>>,
    pub expanded_groups: Arc<Mutex<HashSet<NodeId>>>,
    pub denied_kinds: Arc<Mutex<HashSet<Kind>>>,
}

impl Shared {
    fn build_options(&self) -> BuildOptions {
        BuildOptions { expanded_groups: self.expanded_groups.lock().unwrap().clone(), ..Default::default() }
    }

    /// Rebuild from the store; returns (new graph, delta vs previous).
    fn rebuild(&self) -> (Graph, crate::graph::GraphDelta) {
        let new = build(&self.store.lock().unwrap(), &self.build_options());
        let mut last = self.graph.lock().unwrap();
        let delta = diff(&last, &new);
        *last = new.clone();
        (new, delta)
    }
}

pub fn spawn_reducer(config: ReducerConfig, shared: Shared, emitter: Arc<dyn Emitter>) -> (mpsc::Sender<ReducerMsg>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel(1024);
    let handle = tokio::spawn(run(config, shared, emitter, rx));
    (tx, handle)
}

async fn run(config: ReducerConfig, shared: Shared, emitter: Arc<dyn Emitter>, mut rx: mpsc::Receiver<ReducerMsg>) {
    let mut init_pending: HashSet<Kind> = config.kinds.iter().copied().collect();
    // Keys not yet re-confirmed since the last `Restarted` of their kind.
    let mut stale: HashMap<Kind, HashSet<ObjectKey>> = HashMap::new();
    let mut initialised = false;
    let mut flush_at: Option<Instant> = None;
    let mut errored_since: HashMap<Kind, Instant> = HashMap::new();
    let mut state = ConnectionState::Connected;
    let mut ticker = tokio::time::interval(config.tick);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        let flush = async move {
            match flush_at {
                Some(at) => tokio::time::sleep_until(at.into()).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                match msg {
                    ReducerMsg::Rebuild => {
                        if initialised {
                            flush_at = None;
                            emit_rebuild(&shared, &emitter);
                        }
                    }
                    ReducerMsg::Store(ev) => {
                        let changed = apply(&shared, ev, &mut init_pending, &mut stale, &mut errored_since, &emitter);
                        if !initialised && init_pending.is_empty() {
                            initialised = true;
                            flush_at = None;
                            let (graph, _) = shared.rebuild();
                            emitter.emit(OutEvent::GraphSnapshot(graph));
                        } else if initialised && changed && flush_at.is_none() {
                            flush_at = Some(Instant::now() + config.debounce);
                        }
                    }
                }
            }
            _ = flush => {
                flush_at = None;
                emit_rebuild(&shared, &emitter);
            }
            _ = ticker.tick() => {
                let now = Instant::now();
                let degraded = errored_since.values().any(|since| now.duration_since(*since) >= config.degraded_after);
                let next = if degraded { ConnectionState::Degraded } else { ConnectionState::Connected };
                if next != state {
                    state = next;
                    emitter.emit(OutEvent::ConnectionState(state));
                    if state == ConnectionState::Connected && initialised {
                        let (graph, _) = shared.rebuild();
                        emitter.emit(OutEvent::GraphSnapshot(graph));
                    }
                }
            }
        }
    }
}

fn emit_rebuild(shared: &Shared, emitter: &Arc<dyn Emitter>) {
    let (_, delta) = shared.rebuild();
    if !delta.is_empty() {
        emitter.emit(OutEvent::GraphDelta(delta));
    }
}

/// Apply one event. Returns true when the store content may have changed.
fn apply(
    shared: &Shared,
    ev: StoreEvent,
    init_pending: &mut HashSet<Kind>,
    stale: &mut HashMap<Kind, HashSet<ObjectKey>>,
    errored_since: &mut HashMap<Kind, Instant>,
    emitter: &Arc<dyn Emitter>,
) -> bool {
    match ev {
        StoreEvent::Applied(obj) => {
            let kind = obj.kind();
            errored_since.remove(&kind);
            if let Some(keys) = stale.get_mut(&kind) {
                keys.remove(&obj.key());
            }
            upsert_if_changed(&shared.store, obj)
        }
        StoreEvent::Deleted(key) => {
            errored_since.remove(&key.kind);
            shared.store.lock().unwrap().remove(&key).is_some()
        }
        StoreEvent::Restarted(kind) => {
            let keys: HashSet<ObjectKey> = shared.store.lock().unwrap().iter_kind(kind).map(|o| o.key()).collect();
            stale.insert(kind, keys);
            false
        }
        StoreEvent::InitDone(kind) => {
            errored_since.remove(&kind);
            init_pending.remove(&kind);
            // Sweep whatever the re-list did not confirm.
            match stale.remove(&kind) {
                Some(keys) if !keys.is_empty() => {
                    let mut store = shared.store.lock().unwrap();
                    for key in &keys {
                        store.remove(key);
                    }
                    true
                }
                _ => false,
            }
        }
        StoreEvent::Recovered(kind) => {
            errored_since.remove(&kind);
            false
        }
        StoreEvent::Failed { kind, error, fatal } => {
            if fatal {
                init_pending.remove(&kind);
                errored_since.remove(&kind);
                stale.remove(&kind);
                shared.denied_kinds.lock().unwrap().insert(kind);
                emitter.emit(OutEvent::ConnectionError(AppError::new(
                    error.kind,
                    format!("{}: {}", kind.as_str(), error.message),
                )));
            } else {
                errored_since.entry(kind).or_insert_with(Instant::now);
            }
            false
        }
    }
}

/// Skip no-op updates (resourceVersion bumps without content change still count as changed —
/// the graph diff filters those out cheaply).
fn upsert_if_changed(store: &Arc<Mutex<Store>>, obj: Object) -> bool {
    let mut store = store.lock().unwrap();
    let key = obj.key();
    let same = store
        .get(&key)
        .map(|existing| existing.to_json_value() == obj.to_json_value())
        .unwrap_or(false);
    if same {
        return false;
    }
    store.upsert(obj);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use crate::session::emitter::{ChannelEmitter, ConnectionState, OutEvent};
    use crate::store::Kind;
    use k8s_openapi::api::core::v1::{ConfigMap, Pod};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use std::time::Duration;
    use tokio::time::timeout;

    fn cm(name: &str) -> Object {
        Object::ConfigMap(ConfigMap { metadata: ObjectMeta { name: Some(name.into()), namespace: Some("n".into()), ..Default::default() }, ..Default::default() })
    }
    fn pod(name: &str) -> Object {
        Object::Pod(Pod { metadata: ObjectMeta { name: Some(name.into()), namespace: Some("n".into()), ..Default::default() }, ..Default::default() })
    }

    fn fast_config(kinds: &[Kind]) -> ReducerConfig {
        ReducerConfig { kinds: kinds.to_vec(), debounce: Duration::from_millis(20), degraded_after: Duration::from_millis(50), tick: Duration::from_millis(10) }
    }

    async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<OutEvent>) -> OutEvent {
        timeout(Duration::from_secs(2), rx.recv()).await.expect("event in time").expect("channel open")
    }

    #[tokio::test]
    async fn snapshot_only_after_all_kinds_init_done() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, handle) = spawn_reducer(fast_config(&[Kind::ConfigMap, Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::Applied(cm("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::ConfigMap))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(rx.try_recv().is_err(), "nothing before every kind is initialised");
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphSnapshot(g) => assert_eq!(g.nodes.len(), 1),
            other => panic!("expected snapshot, got {other:?}"),
        }
        drop(tx);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn changes_after_snapshot_are_debounced_into_one_delta() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("b")))).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphDelta(d) => {
                assert_eq!(d.added_nodes.len(), 2);
                assert!(d.removed_nodes.is_empty());
            }
            other => panic!("expected delta, got {other:?}"),
        }
        // Re-applying identical objects produces no delta.
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(rx.try_recv().is_err());
        assert_eq!(shared.graph.lock().unwrap().nodes.len(), 2);
    }

    #[tokio::test]
    async fn fatal_failure_counts_as_init_done_and_reports_error() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Secret, Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::Failed { kind: Kind::Secret, error: AppError::new(ErrorKind::Forbidden, "no"), fatal: true })).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        assert!(shared.denied_kinds.lock().unwrap().contains(&Kind::Secret));
    }

    #[tokio::test]
    async fn prolonged_error_degrades_then_recovers_with_snapshot() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        tx.send(ReducerMsg::Store(StoreEvent::Failed { kind: Kind::Pod, error: AppError::new(ErrorKind::Network, "eof"), fatal: false })).await.unwrap();
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Degraded));
        tx.send(ReducerMsg::Store(StoreEvent::Recovered(Kind::Pod))).await.unwrap();
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
    }

    #[tokio::test]
    async fn restart_sweeps_objects_missing_from_the_relist() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("b")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(g) if g.nodes.len() == 2));
        // Watcher re-lists; only "a" still exists on the server.
        tx.send(ReducerMsg::Store(StoreEvent::Restarted(Kind::Pod))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphDelta(d) => assert_eq!(d.removed_nodes, vec!["Pod/n/b"]),
            other => panic!("expected delta removing b, got {other:?}"),
        }
        assert_eq!(shared.store.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn fatal_internal_failure_keeps_its_error_kind() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::Failed { kind: Kind::Pod, error: AppError::internal("Pod watcher panicked"), fatal: true })).await.unwrap();
        match next(&mut rx).await {
            OutEvent::ConnectionError(e) => assert_eq!(e.kind, ErrorKind::Internal),
            other => panic!("expected connection error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rebuild_message_forces_immediate_rebuild() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        shared.store.lock().unwrap().upsert(pod("x")); // simulate an external change
        tx.send(ReducerMsg::Rebuild).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphDelta(_)));
    }
}
