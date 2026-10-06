//! Consumes StoreEvents, keeps the Store and last Graph, emits snapshots/deltas.

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
use super::scope::StreamId;
use super::shared::Shared;
use super::watch::StoreEvent;
use crate::error::{AppError, ErrorKind};
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
    /// The watch streams whose initial lists make up the first snapshot.
    pub streams: Vec<StreamId>,
    pub debounce: Duration,
    pub degraded_after: Duration,
    pub tick: Duration,
}

impl Default for ReducerConfig {
    fn default() -> Self {
        Self {
            streams: Kind::WATCHED.iter().map(|k| StreamId::from(*k)).collect(),
            debounce: Duration::from_millis(150),
            degraded_after: Duration::from_secs(30),
            tick: Duration::from_secs(5),
        }
    }
}

/// What became of a stream the reducer waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamState {
    /// Its initial list is not complete yet.
    Pending,
    /// Listed at least once.
    Live,
    /// Stopped for good (forbidden, API not served, or a panicked watcher).
    Dead,
}

/// The streams the reducer tracks, with a running count of the pending ones so the first-snapshot
/// gate is O(1) per event.
#[derive(Debug, Default)]
struct Streams {
    states: HashMap<StreamId, StreamState>,
    pending: usize,
    /// Kinds whose cluster-wide watch was forbidden and now run per namespace.
    fell_back: HashSet<Kind>,
}

impl Streams {
    fn new(streams: &[StreamId]) -> Self {
        let mut this = Self::default();
        for s in streams {
            this.set(s.clone(), StreamState::Pending);
        }
        this
    }

    fn set(&mut self, stream: StreamId, state: StreamState) {
        let old = self.states.insert(stream, state);
        self.pending += usize::from(state == StreamState::Pending);
        self.pending -= usize::from(old == Some(StreamState::Pending));
    }

    fn remove(&mut self, stream: &StreamId) {
        if self.states.remove(stream) == Some(StreamState::Pending) {
            self.pending -= 1;
        }
    }

    fn contains(&self, stream: &StreamId) -> bool {
        self.states.contains_key(stream)
    }

    fn any_pending(&self) -> bool {
        self.pending > 0
    }

    fn of_kind(&self, kind: Kind) -> impl Iterator<Item = (&StreamId, StreamState)> {
        self.states.iter().filter(move |(s, _)| s.kind == kind).map(|(s, st)| (s, *st))
    }
}

/// The streams an object of `kind` in `namespace` can come from: the kind's cluster-wide stream
/// and, for a namespaced object, its namespace's stream. Looking these two up directly keeps an
/// Applied/Deleted from scanning every stream's bookkeeping.
fn covering(kind: Kind, namespace: Option<&str>) -> impl Iterator<Item = StreamId> {
    std::iter::once(StreamId::cluster(kind)).chain(namespace.map(|ns| StreamId::namespaced(kind, ns)))
}

/// Whether `kind` is marked (partial, denied) in `shared`.
fn kind_marks(shared: &Shared, kind: Kind) -> (bool, bool) {
    (shared.partial_kinds().contains(&kind), shared.denied_kinds().contains(&kind))
}

/// Mark `kind` from its streams. Denied: none of its streams is left alive (a fallback to no
/// namespace has none at all). Partial, otherwise: it runs per namespace because its cluster-wide
/// watch was forbidden, or some of its streams are dead (forbidden namespaces). A dead stream never
/// comes back, so a kind whose remaining streams all list stays partial only while on the fallback.
/// Returns whether that changed the kind's marks, i.e. whether there is news to report.
fn mark_kind(shared: &Shared, streams: &Streams, kind: Kind) -> bool {
    let before = kind_marks(shared, kind);
    let (mut total, mut dead) = (0, 0);
    for (_, st) in streams.of_kind(kind) {
        total += 1;
        dead += usize::from(st == StreamState::Dead);
    }
    let denied = dead == total;
    let partial = !denied && (dead > 0 || streams.fell_back.contains(&kind));
    let set = |marks: &mut HashSet<Kind>, on: bool| {
        if on {
            marks.insert(kind);
        } else {
            marks.remove(&kind);
        }
    };
    set(&mut shared.denied_kinds(), denied);
    set(&mut shared.partial_kinds(), partial);
    kind_marks(shared, kind) != before
}

pub fn spawn_reducer(config: ReducerConfig, shared: Shared, emitter: Arc<dyn Emitter>) -> (mpsc::Sender<ReducerMsg>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel(1024);
    let handle = tokio::spawn(run(config, shared, emitter, rx));
    (tx, handle)
}

async fn run(config: ReducerConfig, shared: Shared, emitter: Arc<dyn Emitter>, mut rx: mpsc::Receiver<ReducerMsg>) {
    let mut streams = Streams::new(&config.streams);
    // Keys not yet re-confirmed since the last `Restarted` of their stream.
    let mut stale: HashMap<StreamId, HashSet<ObjectKey>> = HashMap::new();
    let mut initialised = false;
    let mut flush_at: Option<Instant> = None;
    let mut errored_since: HashMap<StreamId, Instant> = HashMap::new();
    let mut state = ConnectionState::Connected;
    // A fresh reducer starts from a known-good state; the frontend may still show
    // `degraded` from the previous namespace.
    emitter.emit(OutEvent::ConnectionState(state));
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
                    ReducerMsg::Store(StoreEvent::Failed {
                        error,
                        fatal: true,
                        ..
                    }) if error.kind == ErrorKind::Auth => {
                        // Expired/invalid credentials doom every watcher, not just this stream:
                        // report it once as a session-level failure and stop, instead of
                        // reporting the same auth error stream-by-stream as the other
                        // watchers fail right behind it.
                        emitter.emit(OutEvent::ConnectionError(AppError::new(
                            ErrorKind::Auth,
                            format!("authentication failed: {}", error.message),
                        )));
                        emitter.emit(OutEvent::ConnectionState(ConnectionState::Disconnected));
                        return;
                    }
                    ReducerMsg::Store(ev) => {
                        let changed = apply(&shared, ev, &mut streams, &mut stale, &mut errored_since, &emitter);
                        if !initialised && !streams.any_pending() {
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

/// A change of the too-large state (or of its counts) goes out as a snapshot: deltas cannot say
/// "the graph is not sent any more". While the graph is too large every (debounced) rebuild goes
/// out as one: its summarised diff is empty, but the tables — then the only view — refetch on it.
fn emit_rebuild(shared: &Shared, emitter: &Arc<dyn Emitter>) {
    let before = shared.graph().too_large.clone();
    let (graph, delta) = shared.rebuild();
    if graph.too_large.is_some() || graph.too_large != before {
        emitter.emit(OutEvent::GraphSnapshot(graph));
    } else if !delta.is_empty() {
        emitter.emit(OutEvent::GraphDelta(delta));
    }
}

/// Apply one event. Returns true when the store content may have changed.
fn apply(
    shared: &Shared,
    ev: StoreEvent,
    streams: &mut Streams,
    stale: &mut HashMap<StreamId, HashSet<ObjectKey>>,
    errored_since: &mut HashMap<StreamId, Instant>,
    emitter: &Arc<dyn Emitter>,
) -> bool {
    let pod_related = matches!(&ev, StoreEvent::Applied(o) if o.kind() == Kind::Pod)
        || matches!(&ev, StoreEvent::Deleted(k) if k.kind == Kind::Pod)
        || matches!(&ev, StoreEvent::InitDone(s) if s.kind == Kind::Pod)
        || matches!(&ev, StoreEvent::FellBack { kind: Kind::Pod, .. });
    let changed = apply_to_store(shared, ev, streams, stale, errored_since, emitter);
    // `InitDone(Pod)` (and `FellBack` of Pods) is `changed` only when it swept something, which
    // is exactly when the pod set differs — so `changed` is the right gate for every pod event.
    if pod_related && changed {
        shared.notify_pods_changed();
    }
    changed
}

fn apply_to_store(
    shared: &Shared,
    ev: StoreEvent,
    streams: &mut Streams,
    stale: &mut HashMap<StreamId, HashSet<ObjectKey>>,
    errored_since: &mut HashMap<StreamId, Instant>,
    emitter: &Arc<dyn Emitter>,
) -> bool {
    match ev {
        StoreEvent::Applied(obj) => {
            let key = obj.key();
            for s in covering(key.kind, key.namespace.as_deref()) {
                errored_since.remove(&s);
                if let Some(keys) = stale.get_mut(&s) {
                    keys.remove(&key);
                }
            }
            upsert_if_changed(shared, obj)
        }
        StoreEvent::Deleted(key) => {
            for s in covering(key.kind, key.namespace.as_deref()) {
                errored_since.remove(&s);
            }
            shared.store().remove(&key).is_some()
        }
        StoreEvent::Restarted(stream) => {
            let keys: HashSet<ObjectKey> = shared
                .store()
                .iter_kind(stream.kind)
                .filter(|o| stream.covers(o.namespace()))
                .map(|o| o.key())
                .collect();
            stale.insert(stream, keys);
            false
        }
        StoreEvent::InitDone(stream) => {
            errored_since.remove(&stream);
            // Sweep whatever the re-list did not confirm.
            let swept = match stale.remove(&stream) {
                Some(keys) if !keys.is_empty() => {
                    let mut store = shared.store();
                    for key in &keys {
                        store.remove(key);
                    }
                    true
                }
                _ => false,
            };
            streams.set(stream, StreamState::Live);
            swept
        }
        StoreEvent::Recovered(stream) => {
            errored_since.remove(&stream);
            false
        }
        StoreEvent::Failed { stream, error, fatal } => {
            if fatal {
                // A dead stream's last-known objects stay in the store (as they always have with
                // one namespace): the kind is marked denied or partial, nothing is swept.
                let kind = stream.kind;
                // A cluster-wide stream that already fell back is no longer tracked: its
                // per-namespace replacements ran inside its task (see `watch_or_fall_back`) and
                // died with it.
                let fell_back = stream.namespace.is_none() && !streams.contains(&stream);
                let dead: Vec<StreamId> = if fell_back {
                    streams
                        .of_kind(kind)
                        .filter(|(s, _)| s.namespace.is_some())
                        .map(|(s, _)| s.clone())
                        .collect()
                } else {
                    vec![]
                };
                let dead = if dead.is_empty() { vec![stream] } else { dead };
                for s in dead {
                    errored_since.remove(&s);
                    stale.remove(&s);
                    streams.set(s, StreamState::Dead);
                }
                // One toast per change of the kind's state (it first turns partial, or turns
                // denied), not one per namespace: 50 forbidden namespaces are one piece of news.
                if mark_kind(shared, streams, kind) {
                    emit_kind_error(emitter, kind, &error);
                }
            } else if !errored_since.contains_key(&stream) {
                // Report the first failure of an outage so the user learns why nothing
                // arrives; the watcher keeps retrying, and repeats stay silent until the
                // stream recovers (any Applied/Deleted/InitDone/Recovered clears the entry).
                // One outage of a kind across several namespaces is reported once.
                let kind_already_out = errored_since.keys().any(|s| s.kind == stream.kind);
                if !kind_already_out {
                    emit_kind_error(emitter, stream.kind, &error);
                }
                errored_since.insert(stream, Instant::now());
            }
            false
        }
        StoreEvent::FellBack { kind, namespaces } => {
            // From now on the kind's streams are exactly the replacements below.
            let old: Vec<StreamId> = streams.of_kind(kind).map(|(s, _)| s.clone()).collect();
            for s in old.iter().chain([&StreamId::cluster(kind)]) {
                streams.remove(s);
                stale.remove(s);
                errored_since.remove(s);
            }
            let replacements: Vec<StreamId> = namespaces.iter().map(|ns| StreamId::namespaced(kind, ns)).collect();
            // What the cluster-wide stream listed in namespaces no replacement covers would
            // otherwise linger forever. Objects in covered namespaces stay: each replacement's
            // first list (`Restarted` .. `InitDone`) confirms or sweeps them.
            let swept = {
                let mut store = shared.store();
                let orphans: Vec<ObjectKey> = store
                    .iter_kind(kind)
                    .filter(|o| !replacements.iter().any(|s| s.covers(o.namespace())))
                    .map(|o| o.key())
                    .collect();
                for key in &orphans {
                    store.remove(key);
                }
                !orphans.is_empty()
            };
            for s in replacements {
                streams.set(s, StreamState::Pending);
            }
            streams.fell_back.insert(kind);
            // No toast: falling back is not a failure; the kind's partial (or, with no namespace
            // to fall back to, denied) mark says it.
            mark_kind(shared, streams, kind);
            swept
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
    #[tokio::test(start_paused = true)]
    async fn crossing_the_size_limit_sends_snapshots_not_deltas() {
        let shared = Shared::default();
        let (emitter, mut rx) = ChannelEmitter::new();
        let emitter: Arc<dyn Emitter> = Arc::new(emitter);
        for i in 0..=crate::graph::MAX_GRAPH_NODES {
            shared.store().upsert(cm(&format!("c{i}")));
        }
        emit_rebuild(&shared, &emitter);
        match rx.try_recv().unwrap() {
            OutEvent::GraphSnapshot(g) => assert_eq!(g.too_large.unwrap().nodes, crate::graph::MAX_GRAPH_NODES + 1),
            other => panic!("expected a too-large snapshot, got {other:?}"),
        }
        emit_rebuild(&shared, &emitter);
        assert!(
            matches!(rx.try_recv().unwrap(), OutEvent::GraphSnapshot(g) if g.too_large.is_some()),
            "every rebuild while too large is a snapshot"
        );
        shared.store().remove(&cm("c0").key());
        shared.store().remove(&cm("c1").key());
        emit_rebuild(&shared, &emitter);
        assert!(
            matches!(rx.try_recv().unwrap(), OutEvent::GraphSnapshot(g) if g.too_large.is_none() && g.nodes.len() == crate::graph::MAX_GRAPH_NODES - 1)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_pod_status_change_while_too_large_still_sends_a_snapshot() {
        let shared = Shared::default();
        let (emitter, mut rx) = ChannelEmitter::new();
        let emitter: Arc<dyn Emitter> = Arc::new(emitter);
        for i in 0..=crate::graph::MAX_GRAPH_NODES {
            shared.store().upsert(cm(&format!("c{i}")));
        }
        shared.store().upsert(pod("p"));
        emit_rebuild(&shared, &emitter);
        assert!(matches!(rx.try_recv().unwrap(), OutEvent::GraphSnapshot(g) if g.too_large.is_some()));
        let Object::Pod(mut p) = pod("p") else { unreachable!() };
        // A change the per-kind counts and worst health do not reflect (the pod IP changes).
        p.status = Some(k8s_openapi::api::core::v1::PodStatus {
            pod_ip: Some("10.0.0.9".into()),
            ..Default::default()
        });
        shared.store().upsert(Object::Pod(p));
        emit_rebuild(&shared, &emitter);
        match rx.try_recv() {
            Ok(OutEvent::GraphSnapshot(g)) => assert!(g.too_large.is_some()),
            other => panic!("expected a too-large snapshot so the tables refresh, got {other:?}"),
        }
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
            streams: kinds.iter().map(|k| StreamId::from(*k)).collect(),
            debounce: Duration::from_millis(20),
            degraded_after: Duration::from_millis(50),
            tick: Duration::from_millis(10),
        }
    }

    /// Spawn a reducer and consume the `Connected` it announces on start, so each test can
    /// focus on the events it is actually about.
    async fn spawn_started(
        kinds: &[Kind],
        shared: Shared,
    ) -> (
        mpsc::Sender<ReducerMsg>,
        JoinHandle<()>,
        tokio::sync::mpsc::UnboundedReceiver<OutEvent>,
    ) {
        let (emitter, mut rx) = ChannelEmitter::new();
        let (tx, handle) = spawn_reducer(fast_config(kinds), shared, Arc::new(emitter));
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        (tx, handle, rx)
    }

    async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<OutEvent>) -> OutEvent {
        timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("event in time")
            .expect("channel open")
    }

    // All tests run on tokio's paused virtual clock (`start_paused = true`): every
    // `tokio::time::sleep`/`interval`/`timeout` inside the reducer and in these tests advances
    // an in-process virtual clock instead of real wall time, so debounce/degraded-after/tick
    // timing is exact and these tests can't flake under CI scheduling jitter.

    #[tokio::test(start_paused = true)]
    async fn reducer_announces_connected_on_start() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let (_tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), Shared::default(), Arc::new(emitter));
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
    }

    #[tokio::test(start_paused = true)]
    async fn snapshot_only_after_all_kinds_init_done() {
        let shared = Shared::default();
        let (tx, handle, mut rx) = spawn_started(&[Kind::ConfigMap, Kind::Pod], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Applied(cm("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::ConfigMap.into())))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(rx.try_recv().is_err(), "nothing before every kind is initialised");
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod.into()))).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphSnapshot(g) => assert_eq!(g.nodes.len(), 1),
            other => panic!("expected snapshot, got {other:?}"),
        }
        drop(tx);
        handle.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn changes_after_snapshot_are_debounced_into_one_delta() {
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_started(&[Kind::Pod], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod.into()))).await.unwrap();
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
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_started(&[Kind::Secret, Kind::Pod], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Failed {
            stream: Kind::Secret.into(),
            error: AppError::new(ErrorKind::Forbidden, "no"),
            fatal: true,
        }))
        .await
        .unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod.into()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        assert!(shared.denied_kinds().contains(&Kind::Secret));
    }

    #[tokio::test(start_paused = true)]
    async fn prolonged_error_degrades_then_recovers_with_snapshot() {
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_started(&[Kind::Pod], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod.into()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        tx.send(ReducerMsg::Store(StoreEvent::Failed {
            stream: Kind::Pod.into(),
            error: AppError::new(ErrorKind::Network, "eof"),
            fatal: false,
        }))
        .await
        .unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Degraded));
        tx.send(ReducerMsg::Store(StoreEvent::Recovered(Kind::Pod.into()))).await.unwrap();
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
    }

    #[tokio::test(start_paused = true)]
    async fn first_non_fatal_failure_is_reported_once() {
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_started(&[Kind::Pod], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod.into()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        let fail = || {
            ReducerMsg::Store(StoreEvent::Failed {
                stream: Kind::Pod.into(),
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
        tx.send(ReducerMsg::Store(StoreEvent::Recovered(Kind::Pod.into()))).await.unwrap();
        tx.send(fail()).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
    }

    #[tokio::test(start_paused = true)]
    async fn restart_sweeps_objects_missing_from_the_relist() {
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_started(&[Kind::Pod], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("b")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod.into()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(g) if g.nodes.len() == 2));
        // Watcher re-lists; only "a" still exists on the server.
        tx.send(ReducerMsg::Store(StoreEvent::Restarted(Kind::Pod.into()))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod.into()))).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphDelta(d) => assert_eq!(d.removed_nodes, vec!["Pod/n/b"]),
            other => panic!("expected delta removing b, got {other:?}"),
        }
        assert_eq!(shared.store().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn fatal_internal_failure_keeps_its_error_kind() {
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_started(&[Kind::Pod], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Failed {
            stream: Kind::Pod.into(),
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
    async fn fatal_auth_failure_disconnects_the_session_once() {
        let shared = Shared::default();
        let (tx, handle, mut rx) = spawn_started(&[Kind::Pod, Kind::Secret], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Failed {
            stream: Kind::Pod.into(),
            error: AppError::new(ErrorKind::Auth, "Unauthorized"),
            fatal: true,
        }))
        .await
        .unwrap();
        // The receiver may already be gone once the reducer loop returns after the first
        // fatal Auth failure, so the second watcher's send can fail — that's expected.
        let _ = tx
            .send(ReducerMsg::Store(StoreEvent::Failed {
                stream: Kind::Secret.into(),
                error: AppError::new(ErrorKind::Auth, "Unauthorized"),
                fatal: true,
            }))
            .await;
        match next(&mut rx).await {
            OutEvent::ConnectionError(e) => {
                assert_eq!(e.kind, ErrorKind::Auth);
                assert!(e.message.contains("Unauthorized"), "{}", e.message);
            }
            other => panic!("expected connection error, got {other:?}"),
        }
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Disconnected));
        // Await the reducer task first so the emitter (and its channel sender) is dropped
        // deterministically before we assert the channel is closed.
        handle.await.unwrap();
        assert!(
            rx.recv().await.is_none(),
            "nothing more should be emitted once the session disconnects"
        );
        assert!(shared.denied_kinds().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn pod_changes_tick_the_broadcast_but_configmaps_do_not() {
        let shared = Shared::default();
        let mut pods = shared.subscribe_pods();
        let (tx, _h, _rx) = spawn_started(&[Kind::Pod, Kind::ConfigMap], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Applied(cm("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(pods.try_recv().is_ok(), "the pod apply ticked");
        assert!(pods.try_recv().is_err(), "the configmap apply did not");
        // `pod("a")` carries no resourceVersion, so the JSON compare makes this a no-op.
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(pods.try_recv().is_err(), "an unchanged re-apply is silent");
        tx.send(ReducerMsg::Store(StoreEvent::Deleted(pod("a").key()))).await.unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(1)).await;
        assert!(pods.try_recv().is_ok(), "the pod delete ticked");
    }

    fn pod_in(ns: &str, name: &str) -> Object {
        Object::Pod(Pod {
            metadata: ObjectMeta {
                name: Some(name.into()),
                namespace: Some(ns.into()),
                ..Default::default()
            },
            ..Default::default()
        })
    }

    fn config_for(streams: &[StreamId]) -> ReducerConfig {
        ReducerConfig {
            streams: streams.to_vec(),
            ..fast_config(&[])
        }
    }

    async fn spawn_streams(
        streams: &[StreamId],
        shared: Shared,
    ) -> (
        mpsc::Sender<ReducerMsg>,
        JoinHandle<()>,
        tokio::sync::mpsc::UnboundedReceiver<OutEvent>,
    ) {
        let (emitter, mut rx) = ChannelEmitter::new();
        let (tx, handle) = spawn_reducer(config_for(streams), shared, Arc::new(emitter));
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        (tx, handle, rx)
    }

    fn transient(stream: &StreamId) -> ReducerMsg {
        ReducerMsg::Store(StoreEvent::Failed {
            stream: stream.clone(),
            error: AppError::new(ErrorKind::Network, "connection reset"),
            fatal: false,
        })
    }

    fn forbid(stream: &StreamId) -> ReducerMsg {
        ReducerMsg::Store(StoreEvent::Failed {
            stream: stream.clone(),
            error: AppError::new(ErrorKind::Forbidden, "no"),
            fatal: true,
        })
    }

    #[tokio::test(start_paused = true)]
    async fn a_relist_of_one_namespace_does_not_sweep_another() {
        let a = StreamId::namespaced(Kind::Pod, "a");
        let b = StreamId::namespaced(Kind::Pod, "b");
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(&[a.clone(), b.clone()], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in("a", "x")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in("b", "y")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(a.clone()))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(rx.try_recv().is_err(), "no snapshot until every stream listed");
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(b.clone()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(g) if g.nodes.len() == 2));
        tx.send(ReducerMsg::Store(StoreEvent::Restarted(a.clone()))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(a))).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphDelta(d) => assert_eq!(d.removed_nodes, vec!["Pod/a/x"]),
            other => panic!("expected only a's pod swept, got {other:?}"),
        }
        assert_eq!(shared.store().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn one_forbidden_namespace_makes_the_kind_partial_all_make_it_denied() {
        let a = StreamId::namespaced(Kind::Secret, "a");
        let b = StreamId::namespaced(Kind::Secret, "b");
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(&[a.clone(), b.clone()], shared.clone()).await;
        tx.send(forbid(&a)).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert!(shared.partial_kinds().contains(&Kind::Secret));
        assert!(!shared.denied_kinds().contains(&Kind::Secret));
        tx.send(forbid(&b)).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert!(shared.denied_kinds().contains(&Kind::Secret));
        assert!(!shared.partial_kinds().contains(&Kind::Secret));
    }

    #[tokio::test(start_paused = true)]
    async fn a_forbidden_namespace_does_not_block_the_snapshot() {
        let a = StreamId::namespaced(Kind::Pod, "a");
        let b = StreamId::namespaced(Kind::Pod, "b");
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(&[a.clone(), b.clone()], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in("a", "x")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(a))).await.unwrap();
        tx.send(forbid(&b)).await.unwrap();
        match next(&mut rx).await {
            OutEvent::ConnectionError(e) => assert!(e.message.contains("Pod"), "{}", e.message),
            other => panic!("expected b's error, got {other:?}"),
        }
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(g) if g.nodes.len() == 1));
        assert!(shared.partial_kinds().contains(&Kind::Pod));
    }

    #[tokio::test(start_paused = true)]
    async fn one_erroring_namespace_degrades_while_the_other_keeps_updating() {
        let a = StreamId::namespaced(Kind::Pod, "a");
        let b = StreamId::namespaced(Kind::Pod, "b");
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(&[a.clone(), b.clone()], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(a.clone()))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(b.clone()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        tx.send(transient(&a)).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        // b's updates neither clear a's outage nor stop flowing.
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in("b", "y")))).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphDelta(d) => assert_eq!(d.added_nodes.len(), 1),
            other => panic!("expected b's pod, got {other:?}"),
        }
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Degraded));
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in("b", "z")))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphDelta(_)));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(rx.try_recv().is_err(), "still degraded: a has not recovered");
        // a's recovery clears the outage, with a fresh snapshot.
        tx.send(ReducerMsg::Store(StoreEvent::Recovered(a))).await.unwrap();
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(g) if g.nodes.len() == 2));
    }

    #[tokio::test(start_paused = true)]
    async fn an_object_of_one_namespace_recovers_only_its_own_stream() {
        let a = StreamId::namespaced(Kind::Pod, "a");
        let b = StreamId::namespaced(Kind::Pod, "b");
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(&[a.clone(), b.clone()], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(a.clone()))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(b.clone()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        tx.send(transient(&a)).await.unwrap();
        tx.send(transient(&b)).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(
            rx.try_recv().is_err(),
            "one outage of a kind is reported once, however many namespaces"
        );
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Degraded));
        // An object arriving from b recovers b, not a.
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in("b", "y")))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphDelta(_)));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(rx.try_recv().is_err(), "a is still out");
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in("a", "x")))).await.unwrap();
        // Recovery and the debounced delta race on the virtual clock; either order is fine.
        let mut got = vec![next(&mut rx).await, next(&mut rx).await];
        got.sort_by_key(|e| matches!(e, OutEvent::ConnectionState(_)));
        assert!(matches!(got[0], OutEvent::GraphDelta(_) | OutEvent::GraphSnapshot(_)), "{got:?}");
        assert!(got.contains(&OutEvent::ConnectionState(ConnectionState::Connected)), "{got:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_fallback_waits_for_the_per_namespace_streams() {
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(&[StreamId::cluster(Kind::Pod)], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Restarted(StreamId::cluster(Kind::Pod))))
            .await
            .unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::FellBack {
            kind: Kind::Pod,
            namespaces: vec!["a".into(), "b".into()],
        }))
        .await
        .unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(StreamId::namespaced(Kind::Pod, "a"))))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(rx.try_recv().is_err(), "b has not listed yet");
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(StreamId::namespaced(Kind::Pod, "b"))))
            .await
            .unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        assert!(shared.partial_kinds().contains(&Kind::Pod));
    }

    #[tokio::test(start_paused = true)]
    async fn a_fallback_with_no_namespace_denies_the_kind() {
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(&[StreamId::cluster(Kind::Pod), StreamId::cluster(Kind::ConfigMap)], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::FellBack {
            kind: Kind::Pod,
            namespaces: vec![],
        }))
        .await
        .unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::ConfigMap.into())))
            .await
            .unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        assert!(shared.denied_kinds().contains(&Kind::Pod));
        assert!(!shared.partial_kinds().contains(&Kind::Pod));
    }

    fn fell_back(kind: Kind, namespaces: &[&str]) -> ReducerMsg {
        ReducerMsg::Store(StoreEvent::FellBack {
            kind,
            namespaces: namespaces.iter().map(|n| n.to_string()).collect(),
        })
    }

    #[tokio::test(start_paused = true)]
    async fn a_fallback_drops_the_objects_of_namespaces_it_does_not_cover() {
        let cluster = StreamId::cluster(Kind::Pod);
        let shared = Shared::default();
        let mut pods = shared.subscribe_pods();
        let (tx, _h, mut rx) = spawn_streams(&[cluster.clone(), StreamId::cluster(Kind::ConfigMap)], shared.clone()).await;
        for (ns, name) in [("a", "x"), ("b", "y"), ("c", "z")] {
            tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in(ns, name)))).await.unwrap();
        }
        tx.send(ReducerMsg::Store(StoreEvent::Applied(cm("keep")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(cluster.clone()))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::ConfigMap.into())))
            .await
            .unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(g) if g.nodes.len() == 4));
        while pods.try_recv().is_ok() {}
        // The cluster-wide watch is forbidden mid-flight; only a and b are watched from now on.
        tx.send(fell_back(Kind::Pod, &["a", "b"])).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphDelta(d) => assert_eq!(d.removed_nodes, vec!["Pod/c/z"]),
            other => panic!("expected c's pod removed, got {other:?}"),
        }
        assert_eq!(shared.store().len(), 3, "a's and b's pods stay until their own lists confirm them");
        assert!(pods.try_recv().is_ok(), "removing pods ticks the pod broadcast");
        assert!(shared.partial_kinds().contains(&Kind::Pod));
        // A fallback to nowhere drops every object of the kind, and nothing else.
        tx.send(fell_back(Kind::Pod, &[])).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphDelta(mut d) => {
                d.removed_nodes.sort();
                assert_eq!(d.removed_nodes, vec!["Pod/a/x", "Pod/b/y"]);
            }
            other => panic!("expected the remaining pods removed, got {other:?}"),
        }
        assert_eq!(shared.store().len(), 1);
        assert!(shared.denied_kinds().contains(&Kind::Pod));
    }

    #[tokio::test(start_paused = true)]
    async fn a_dead_namespaced_stream_keeps_its_last_known_objects() {
        // Single-namespace behaviour, unchanged: a stream that stops for good (e.g. RBAC revoked
        // mid-watch) leaves what it last listed on screen, and the kind is marked denied.
        let a = StreamId::namespaced(Kind::Pod, "a");
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(std::slice::from_ref(&a), shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in("a", "x")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(a.clone()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        tx.send(forbid(&a)).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(rx.try_recv().is_err(), "nothing removed");
        assert_eq!(shared.store().len(), 1);
        assert!(shared.denied_kinds().contains(&Kind::Pod));
    }

    #[tokio::test(start_paused = true)]
    async fn a_fell_back_cluster_stream_that_dies_takes_its_replacements_with_it() {
        // The per-namespace watches run inside the cluster-wide stream's task: if that task dies
        // (a panic), they are gone too, so the kind is denied, not partial with a ghost stream.
        let cluster = StreamId::cluster(Kind::Pod);
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(std::slice::from_ref(&cluster), shared.clone()).await;
        tx.send(fell_back(Kind::Pod, &["a", "b"])).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod_in("a", "x")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(StreamId::namespaced(Kind::Pod, "a"))))
            .await
            .unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Failed {
            stream: cluster.clone(),
            error: AppError::internal("Pod watcher panicked"),
            fatal: true,
        }))
        .await
        .unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        // b never listed, but it is dead now: the snapshot does not wait for it.
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(g) if g.nodes.len() == 1));
        assert!(shared.denied_kinds().contains(&Kind::Pod));
        assert!(!shared.partial_kinds().contains(&Kind::Pod));
    }

    /// Every event up to and including the first snapshot.
    async fn until_snapshot(rx: &mut tokio::sync::mpsc::UnboundedReceiver<OutEvent>) -> Vec<OutEvent> {
        let mut got = vec![];
        loop {
            let ev = next(rx).await;
            let done = matches!(ev, OutEvent::GraphSnapshot(_));
            got.push(ev);
            if done {
                return got;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn fifty_forbidden_namespaces_of_a_kind_are_reported_once() {
        let dying: Vec<StreamId> = (0..50).map(|i| StreamId::namespaced(Kind::Secret, &format!("ns-{i}"))).collect();
        let live = StreamId::namespaced(Kind::Secret, "mine");
        let mut plan = dying.clone();
        plan.push(live.clone());
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(&plan, shared.clone()).await;
        for s in &dying {
            tx.send(forbid(s)).await.unwrap();
        }
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(live))).await.unwrap();
        let errors = until_snapshot(&mut rx)
            .await
            .into_iter()
            .filter(|e| matches!(e, OutEvent::ConnectionError(_)))
            .count();
        assert_eq!(errors, 1, "one toast for the kind, not one per namespace");
        assert!(shared.partial_kinds().contains(&Kind::Secret));
    }

    #[tokio::test(start_paused = true)]
    async fn the_snapshot_gate_opens_exactly_when_the_last_pending_stream_lists() {
        let [a, b, c] = ["a", "b", "c"].map(|ns| StreamId::namespaced(Kind::Pod, ns));
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_streams(
            &[a.clone(), b.clone(), c.clone(), StreamId::cluster(Kind::ConfigMap)],
            shared.clone(),
        )
        .await;
        let quiet = |rx: &mut tokio::sync::mpsc::UnboundedReceiver<OutEvent>, why: &str| {
            while let Ok(ev) = rx.try_recv() {
                assert!(!matches!(ev, OutEvent::GraphSnapshot(_)), "{why}: {ev:?}");
            }
        };
        // Re-listing a stream that already listed counts it once.
        for ev in [
            StoreEvent::InitDone(a.clone()),
            StoreEvent::Restarted(a.clone()),
            StoreEvent::InitDone(a.clone()),
            StoreEvent::InitDone(a.clone()),
        ] {
            tx.send(ReducerMsg::Store(ev)).await.unwrap();
        }
        // A stream outside the plan is not one the gate waits for, nor one that opens it.
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(StreamId::namespaced(Kind::Pod, "zzz"))))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        quiet(&mut rx, "b, c and ConfigMaps are pending");
        // A dead stream stops being waited for.
        tx.send(forbid(&b)).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::ConfigMap.into())))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        quiet(&mut rx, "c is pending");
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(c))).await.unwrap();
        assert!(matches!(until_snapshot(&mut rx).await.last(), Some(OutEvent::GraphSnapshot(_))));
        // A fallback's replacements are pending too, but only before the first snapshot gates.
        tx.send(fell_back(Kind::ConfigMap, &["a"])).await.unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        quiet(&mut rx, "one snapshot only");
    }

    #[tokio::test(start_paused = true)]
    async fn partial_means_on_the_fallback_or_some_namespaces_forbidden() {
        // Pods: a set whose every namespace lists is not partial; one forbidden namespace makes it so.
        // Secrets: a cluster-wide watch that fell back is partial even when every namespace lists,
        // and denied (not partial) once every replacement is dead.
        let [pa, pb] = ["a", "b"].map(|ns| StreamId::namespaced(Kind::Pod, ns));
        let [ca, cb] = ["a", "b"].map(|ns| StreamId::namespaced(Kind::ConfigMap, ns));
        let secrets = StreamId::cluster(Kind::Secret);
        let shared = Shared::default();
        let plan = [pa.clone(), pb.clone(), ca.clone(), cb.clone(), secrets];
        let (tx, _h, mut rx) = spawn_streams(&plan, shared.clone()).await;
        tx.send(fell_back(Kind::Secret, &["a", "b"])).await.unwrap();
        for s in [
            &pa,
            &pb,
            &ca,
            &StreamId::namespaced(Kind::Secret, "a"),
            &StreamId::namespaced(Kind::Secret, "b"),
        ] {
            tx.send(ReducerMsg::Store(StoreEvent::InitDone(s.clone()))).await.unwrap();
        }
        tx.send(forbid(&cb)).await.unwrap();
        until_snapshot(&mut rx).await;
        let partial = shared.partial_kinds().clone();
        assert!(!partial.contains(&Kind::Pod), "every namespace listed: {partial:?}");
        assert!(partial.contains(&Kind::ConfigMap), "one namespace forbidden: {partial:?}");
        assert!(partial.contains(&Kind::Secret), "running on the fallback: {partial:?}");
        assert!(shared.denied_kinds().is_empty());
        for ns in ["a", "b"] {
            tx.send(forbid(&StreamId::namespaced(Kind::Secret, ns))).await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(shared.denied_kinds().contains(&Kind::Secret));
        assert!(!shared.partial_kinds().contains(&Kind::Secret));
    }

    #[tokio::test(start_paused = true)]
    async fn rebuild_message_forces_immediate_rebuild() {
        let shared = Shared::default();
        let (tx, _h, mut rx) = spawn_started(&[Kind::Pod], shared.clone()).await;
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod.into()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        shared.store().upsert(pod("x")); // simulate an external change
        tx.send(ReducerMsg::Rebuild).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphDelta(_)));
    }
}
