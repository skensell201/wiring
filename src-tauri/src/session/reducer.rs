//! Consumes StoreEvents, keeps the Store and last Graph, emits snapshots/deltas.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::JoinHandle;
// `tokio::time::Instant`, not `std::time::Instant`: under `#[tokio::test(start_paused = true)]`
// only the tokio clock is virtual, so debounce/degraded-after timing must be read from it too —
// a `std::time::Instant::now()` read here would silently use real wall-clock time and never
// observe the paused advances the tests rely on.
use tokio::time::Instant;

use super::emitter::{ConnectionState, Emitter, OutEvent};
use super::shared::Shared;
use super::watch::StoreEvent;
use crate::error::AppError;
use crate::store::{Kind, Object, ObjectKey};

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
                Some(at) => tokio::time::sleep_until(at).await,
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

fn emit_kind_error(emitter: &Arc<dyn Emitter>, kind: Kind, error: &AppError) {
    emitter.emit(OutEvent::ConnectionError(AppError::new(
        error.kind,
        format!("{}: {}", kind.as_str(), error.message),
    )));
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
            upsert_if_changed(shared, obj)
        }
        StoreEvent::Deleted(key) => {
            errored_since.remove(&key.kind);
            shared.store().remove(&key).is_some()
        }
        StoreEvent::Restarted(kind) => {
            let keys: HashSet<ObjectKey> = shared.store().iter_kind(kind).map(|o| o.key()).collect();
            stale.insert(kind, keys);
            false
        }
        StoreEvent::InitDone(kind) => {
            errored_since.remove(&kind);
            init_pending.remove(&kind);
            // Sweep whatever the re-list did not confirm.
            match stale.remove(&kind) {
                Some(keys) if !keys.is_empty() => {
                    let mut store = shared.store();
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
                shared.denied_kinds().insert(kind);
                emit_kind_error(emitter, kind, &error);
            } else if let Entry::Vacant(slot) = errored_since.entry(kind) {
                // Report the first failure of an outage so the user learns why nothing
                // arrives; the watcher keeps retrying, and repeats stay silent until the
                // kind recovers (any Applied/Deleted/InitDone/Recovered clears the entry).
                slot.insert(Instant::now());
                emit_kind_error(emitter, kind, &error);
            }
            false
        }
    }
}

/// Skip no-op updates. A real API server always sets `metadata.resourceVersion` and bumps it
/// on every write, so two observations of the same key with equal resource versions must have
/// identical content — skip the (more expensive) full JSON comparison in that case. Falls back
/// to the JSON compare when either side lacks a resourceVersion (e.g. in tests).
fn upsert_if_changed(shared: &Shared, obj: Object) -> bool {
    let mut store = shared.store();
    let key = obj.key();
    let same = match store.get(&key) {
        Some(existing) => match (existing.meta().resource_version.as_ref(), obj.meta().resource_version.as_ref()) {
            (Some(a), Some(b)) if a == b => true,
            _ => existing.to_json_value() == obj.to_json_value(),
        },
        None => false,
    };
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
        Object::ConfigMap(ConfigMap {
            metadata: ObjectMeta {
                name: Some(name.into()),
                namespace: Some("n".into()),
                ..Default::default()
            },
            ..Default::default()
        })
    }
    fn pod(name: &str) -> Object {
        Object::Pod(Pod {
            metadata: ObjectMeta {
                name: Some(name.into()),
                namespace: Some("n".into()),
                ..Default::default()
            },
            ..Default::default()
        })
    }

    fn fast_config(kinds: &[Kind]) -> ReducerConfig {
        ReducerConfig {
            kinds: kinds.to_vec(),
            debounce: Duration::from_millis(20),
            degraded_after: Duration::from_millis(50),
            tick: Duration::from_millis(10),
        }
    }

    async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<OutEvent>) -> OutEvent {
        timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("event in time")
            .expect("channel open")
    }

    // All 7 tests run on tokio's paused virtual clock (`start_paused = true`): every
    // `tokio::time::sleep`/`interval`/`timeout` inside the reducer and in these tests advances
    // an in-process virtual clock instead of real wall time, so debounce/degraded-after/tick
    // timing is exact and these tests can't flake under CI scheduling jitter.

    #[tokio::test(start_paused = true)]
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

    #[tokio::test(start_paused = true)]
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
        assert_eq!(shared.graph().nodes.len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn fatal_failure_counts_as_init_done_and_reports_error() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Secret, Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::Failed {
            kind: Kind::Secret,
            error: AppError::new(ErrorKind::Forbidden, "no"),
            fatal: true,
        }))
        .await
        .unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        assert!(shared.denied_kinds().contains(&Kind::Secret));
    }

    #[tokio::test(start_paused = true)]
    async fn prolonged_error_degrades_then_recovers_with_snapshot() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        tx.send(ReducerMsg::Store(StoreEvent::Failed {
            kind: Kind::Pod,
            error: AppError::new(ErrorKind::Network, "eof"),
            fatal: false,
        }))
        .await
        .unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Degraded));
        tx.send(ReducerMsg::Store(StoreEvent::Recovered(Kind::Pod))).await.unwrap();
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
    }

    #[tokio::test(start_paused = true)]
    async fn first_non_fatal_failure_is_reported_once() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        let fail = || {
            ReducerMsg::Store(StoreEvent::Failed {
                kind: Kind::Pod,
                error: AppError::new(ErrorKind::Network, "connection reset"),
                fatal: false,
            })
        };
        tx.send(fail()).await.unwrap();
        tx.send(fail()).await.unwrap();
        match next(&mut rx).await {
            OutEvent::ConnectionError(e) => {
                assert_eq!(e.kind, ErrorKind::Network);
                assert!(e.message.contains("connection reset"), "{}", e.message);
                assert!(e.message.contains("Pod"), "{}", e.message);
            }
            other => panic!("expected the first failure to be reported, got {other:?}"),
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(rx.try_recv().is_err(), "repeated failures of the same kind stay silent");
        // The kind is not degraded yet, so recovery is silent; the next outage is reported again.
        tx.send(ReducerMsg::Store(StoreEvent::Recovered(Kind::Pod))).await.unwrap();
        tx.send(fail()).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
    }

    #[tokio::test(start_paused = true)]
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
        assert_eq!(shared.store().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn fatal_internal_failure_keeps_its_error_kind() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::Failed {
            kind: Kind::Pod,
            error: AppError::internal("Pod watcher panicked"),
            fatal: true,
        }))
        .await
        .unwrap();
        match next(&mut rx).await {
            OutEvent::ConnectionError(e) => assert_eq!(e.kind, ErrorKind::Internal),
            other => panic!("expected connection error, got {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn rebuild_message_forces_immediate_rebuild() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        shared.store().upsert(pod("x")); // simulate an external change
        tx.send(ReducerMsg::Rebuild).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphDelta(_)));
    }
}
