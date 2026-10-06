# Several Namespaces and "All namespaces" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch more than one namespace at a time — a set of namespaces or **All namespaces** — and show them in one graph (a lane per namespace), one set of tables (with a Namespace column) and one navigator.

**Architecture:** The namespace session gets a `NamespaceScope` (`All` or a set). A pure `watch_plan(scope)` turns it into *watch streams* (`StreamId { kind, namespace: Option<String> }`): one cluster-wide stream per kind for `All`, one stream per (kind, namespace) for a set; PersistentVolumes stay one cluster-wide stream. `StoreEvent`s carry their `StreamId`, so the reducer tracks initial lists, re-list sweeps, errors and RBAC per stream (a re-list of `Pod/shop` must not sweep `Pod/blog`). A cluster-wide stream that is forbidden falls back to per-namespace streams (`StoreEvent::FellBack`) and its kind is reported *partial*. Metrics are listed per scope and keyed `namespace/name`. Graphs with more than 1 500 nodes are replaced at the backend by a summary (`tooLarge`), so huge graphs never cross IPC. The frontend keeps `connection.scope`, a multi-select picker, lays the graph out in lanes, and shows tables with the backend-provided Namespace column.

**Tech Stack:** Rust (kube 4.2 runtime watcher, k8s-openapi 0.28, tokio), Tauri 2 commands/events, React 19 + zustand, @xyflow/react 12, Vitest + Testing Library.

Spec: `docs/superpowers/specs/2026-10-06-multi-namespace-design.md`.

**Single-namespace assumptions found in the code, and where each is handled:**

| Place | Assumption | Task |
|---|---|---|
| `session/watch.rs` `spawn_all(client, namespace, tx)` | one namespaced watcher per kind | 2, 3 |
| `session/reducer.rs` init/sweep/errors keyed by `Kind` | one stream per kind | 2 |
| `session/mod.rs` `select_namespace(&str)` | one namespace | 5, 17 |
| `session/metrics.rs` `Api::namespaced_with(namespace)`; `MetricsSample.pods` keyed by pod name | one namespace, unique pod names | 4 |
| `graph::rows::table` | no namespace column | 7 |
| `commands.rs` `select_namespace` | one namespace | 5, 17 |
| `src/app/store.ts` `connection.namespace`, `selectNamespace`, `pendingNamespace`, snapshot guard, `refreshTable` guard, `reconnect`, create template | one namespace | 11, 15 |
| `src/shared/settings.ts` `lastNamespace` | one namespace | 10 |
| `src/app/startup.ts` | restores one namespace | 11 |
| `NamespacePicker.tsx` | `<select>` | 12 |
| `Header.tsx` Create disabled when `namespace === null` | — | 12 |
| `Canvas.tsx` overlay text and refit on `namespace` | — | 11, 16 |
| `ViewHeader.tsx` caption, `TableView.tsx` empty messages | namespace name | 11 |
| `CreateDialog.tsx` "in {namespace}" | — | 15 |
| `features/graph/toFlow.ts` / `layout.ts` | one flat layout | 13 |
| **Left per-object (already use the object's own namespace):** relations (`graph/relations.rs`, same-namespace matching), `status.rs` service selectors, `PodIndex`, `is_owned_by`, rollout history, `get_object`, `watch_events`, logs targets, exec targets, port-forward resolution, `create_object` (manifest namespace wins), YAML edit/delete | — | none |

---

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/session/scope.rs` (new) | `NamespaceScope`, `StreamId`, `watch_plan` — pure |
| `src-tauri/src/manifest.rs` | `validate_dns_subdomain` becomes `pub(crate)` |
| `src-tauri/src/session/watch.rs` | `StoreEvent` per stream, `translate` end states, `spawn_plan`, cluster→per-namespace fallback |
| `src-tauri/src/session/reducer.rs` | per-stream init/sweep/errors, `FellBack`, denied vs partial, tooLarge snapshot rule |
| `src-tauri/src/session/shared.rs` | `partial_kinds`; tooLarge guard in `rebuild` |
| `src-tauri/src/session/metrics.rs` | poll per scope |
| `src-tauri/src/metrics/{mod,sample,usage}.rs` | `pod_key(namespace, name)` |
| `src-tauri/src/session/mod.rs` | `scope`, `namespaces`, `select_scope`, `partial_kinds`, `list_rows` namespace column |
| `src-tauri/src/graph/model.rs` | `MAX_GRAPH_NODES`, `KindStat`, `TooLarge`, `Graph.too_large`, `Graph::summarised` |
| `src-tauri/src/graph/rows.rs` | `with_namespace_column` |
| `src-tauri/src/commands.rs`, `lib.rs` registration | `select_namespaces`, `partial_kinds`; later remove `select_namespace` |
| `docs/ipc-contract.md`, `src/shared/ipc/fixtures/graph_too_large.json` (new), `src-tauri/tests/ipc_fixtures.rs` | contract |
| `src-tauri/tests/fixtures/smoke-b.yaml` (new), `src-tauri/tests/smoke.rs` | `exercise_scopes` |
| `src/shared/ipc/{types,commands}.ts`, `fixtures.test.ts` | `NamespaceScope`, `TooLarge`, `KindStat`, `selectNamespaces`, `partialKinds` |
| `src/shared/scope.ts` (new, + test) | `scopeLabel`, `isMulti`, `inScope`, `firstNamespace` |
| `src/shared/settings.ts` (+ test) | `getLastScope` / `setLastScope` with migration from `lastNamespace` |
| `src/app/store.ts`, `startup.ts`, `wireEvents.ts` (+ tests) | `connection.scope`, `selectScope`, `tooLarge`, `partialKinds`, create namespace |
| `src/features/cluster/NamespacePicker.tsx`, `Header.tsx` (+ `cluster.test.tsx`) | multi-select picker |
| `src/features/graph/toFlow.ts`, `LaneNode.tsx` (new), `Canvas.tsx` (+ tests) | lanes, tooLarge notice |
| `src/features/navigator/ResourceTree.tsx`, `src/features/graph/ViewHeader.tsx`, `src/features/table/TableView.tsx` (+ tests) | counts from tooLarge, partial marker, captions |
| `src/features/editor/CreateDialog.tsx` (+ test) | namespace select |
| `README.md` | feature paragraph |

---

### Task 1: `NamespaceScope`, `StreamId` and the watch plan

**Files:**
- Create: `src-tauri/src/session/scope.rs`
- Modify: `src-tauri/src/session/mod.rs` (add `pub mod scope;`), `src-tauri/src/manifest.rs` (visibility)

- [ ] **Step 1: Make the DNS check reusable** — in `src-tauri/src/manifest.rs` change `fn validate_dns_subdomain(` to `pub(crate) fn validate_dns_subdomain(`.

- [ ] **Step 2: Write the failing tests** — create `src-tauri/src/session/scope.rs` with only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    #[test]
    fn from_arg_reads_all_and_sets() {
        assert_eq!(NamespaceScope::from_arg(None).unwrap(), NamespaceScope::All);
        let s = NamespaceScope::from_arg(Some(vec![" shop ".into(), "blog".into(), "shop".into()])).unwrap();
        assert_eq!(s, NamespaceScope::Set(["blog".to_string(), "shop".to_string()].into_iter().collect()));
        assert_eq!(NamespaceScope::from_arg(Some(vec![])).unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(NamespaceScope::from_arg(Some(vec!["  ".into()])).unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(NamespaceScope::from_arg(Some(vec!["Bad/ns".into()])).unwrap_err().kind, ErrorKind::Invalid);
    }

    #[test]
    fn multi_means_more_than_one_namespace() {
        assert!(NamespaceScope::All.is_multi());
        assert!(!NamespaceScope::single("shop").is_multi());
        assert!(NamespaceScope::from_arg(Some(vec!["a".into(), "b".into()])).unwrap().is_multi());
    }

    #[test]
    fn a_stream_covers_its_namespace_or_everything() {
        assert!(StreamId::cluster(Kind::Pod).covers(Some("x")));
        assert!(StreamId::cluster(Kind::PersistentVolume).covers(None));
        assert!(StreamId::namespaced(Kind::Pod, "a").covers(Some("a")));
        assert!(!StreamId::namespaced(Kind::Pod, "a").covers(Some("b")));
        assert_eq!(StreamId::from(Kind::Pod), StreamId::cluster(Kind::Pod));
    }

    #[test]
    fn plan_is_per_namespace_for_sets_and_cluster_wide_for_all() {
        let one = watch_plan(&NamespaceScope::single("shop"));
        assert_eq!(one.len(), Kind::WATCHED.len());
        assert!(one.contains(&StreamId::namespaced(Kind::Pod, "shop")));
        assert!(one.contains(&StreamId::cluster(Kind::PersistentVolume)));

        let two = watch_plan(&NamespaceScope::from_arg(Some(vec!["a".into(), "b".into()])).unwrap());
        assert_eq!(two.len(), (Kind::WATCHED.len() - 1) * 2 + 1);
        assert!(two.contains(&StreamId::namespaced(Kind::Secret, "a")));
        assert!(two.contains(&StreamId::namespaced(Kind::Secret, "b")));
        assert_eq!(two.iter().filter(|s| s.kind == Kind::PersistentVolume).count(), 1);

        let all = watch_plan(&NamespaceScope::All);
        assert_eq!(all.len(), Kind::WATCHED.len());
        assert!(all.iter().all(|s| s.namespace.is_none()));
    }
}
```

Add `pub mod scope;` to `src-tauri/src/session/mod.rs` (after `pub mod rollout;`).

- [ ] **Step 3: Run to see it fail**

Run: `cd src-tauri && cargo test --lib session::scope`
Expected: FAIL to compile (`NamespaceScope`, `StreamId`, `watch_plan` not found).

- [ ] **Step 4: Implement** — put this above the test module in `scope.rs`:

```rust
//! Which namespaces a session watches, and the watch streams that takes
//! (spec: docs/superpowers/specs/2026-10-06-multi-namespace-design.md).

use std::collections::BTreeSet;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::store::Kind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamespaceScope {
    All,
    /// Never empty.
    Set(BTreeSet<String>),
}

impl NamespaceScope {
    pub fn single(namespace: &str) -> Self {
        Self::Set(BTreeSet::from([namespace.to_string()]))
    }

    /// The `select_namespaces` argument: `None` is all namespaces; a list is trimmed, deduplicated
    /// and must name at least one valid namespace.
    pub fn from_arg(namespaces: Option<Vec<String>>) -> AppResult<Self> {
        let Some(list) = namespaces else { return Ok(Self::All) };
        let set: BTreeSet<String> = list.into_iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
        if set.is_empty() {
            return Err(AppError::new(ErrorKind::Invalid, "pick at least one namespace"));
        }
        for ns in &set {
            crate::manifest::validate_dns_subdomain("namespace", ns)?;
        }
        Ok(Self::Set(set))
    }

    /// More than one namespace on screen: tables get a Namespace column, the graph gets lanes.
    pub fn is_multi(&self) -> bool {
        match self {
            Self::All => true,
            Self::Set(set) => set.len() > 1,
        }
    }
}

/// One watch stream: a kind in one namespace, or cluster-wide (`namespace: None`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StreamId {
    pub kind: Kind,
    pub namespace: Option<String>,
}

impl StreamId {
    pub fn cluster(kind: Kind) -> Self {
        Self { kind, namespace: None }
    }

    pub fn namespaced(kind: Kind, namespace: &str) -> Self {
        Self {
            kind,
            namespace: Some(namespace.to_string()),
        }
    }

    /// Whether an object of this stream's kind in `namespace` comes from this stream.
    pub fn covers(&self, namespace: Option<&str>) -> bool {
        self.namespace.is_none() || self.namespace.as_deref() == namespace
    }
}

impl From<Kind> for StreamId {
    fn from(kind: Kind) -> Self {
        Self::cluster(kind)
    }
}

/// The streams `scope` needs: PersistentVolumes are always one cluster-wide stream; every other
/// kind is one cluster-wide stream for `All`, or one per namespace for a set.
pub fn watch_plan(scope: &NamespaceScope) -> Vec<StreamId> {
    let mut plan = Vec::new();
    for kind in Kind::WATCHED {
        match scope {
            _ if kind.is_cluster_scoped() => plan.push(StreamId::cluster(kind)),
            NamespaceScope::All => plan.push(StreamId::cluster(kind)),
            NamespaceScope::Set(set) => plan.extend(set.iter().map(|ns| StreamId::namespaced(kind, ns))),
        }
    }
    plan
}
```

- [ ] **Step 5: Run the tests** — `cd src-tauri && cargo test --lib session::scope && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → PASS (if clippy flags `scope.rs` items as unused, add `#[allow(dead_code)]` nowhere — they are `pub` in a `pub mod`, so no dead-code warning is expected).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/session/scope.rs src-tauri/src/session/mod.rs src-tauri/src/manifest.rs
git commit -m "$(cat <<'EOF'
Add the namespace scope, watch streams and the watch plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 2: Store events and the reducer per watch stream

The riskiest task: the reducer's bookkeeping moves from `Kind` to `StreamId`. Behaviour for a single namespace must stay identical (every existing reducer test keeps passing after the mechanical edits below).

**Files:**
- Modify: `src-tauri/src/session/watch.rs`, `src-tauri/src/session/reducer.rs`, `src-tauri/src/session/shared.rs`, `src-tauri/src/session/mod.rs`

- [ ] **Step 1: `Shared` gets partial kinds** — in `shared.rs` add a field `partial_kinds: Arc<Mutex<HashSet<Kind>>>` (doc: `/// Kinds watched in some namespaces but forbidden in others (or cluster-wide).`), initialise it with `Arc::default()` in `Default`, and add:

```rust
    pub fn partial_kinds(&self) -> MutexGuard<'_, HashSet<Kind>> {
        lock(&self.partial_kinds)
    }
```

- [ ] **Step 2: `StoreEvent` per stream** — in `watch.rs` add `use super::scope::StreamId;` and replace the enum's per-kind variants:

```rust
pub enum StoreEvent {
    Applied(Object),
    Deleted(ObjectKey),
    /// The watch stream restarted (e.g. after a 410 Gone re-list). The reducer should
    /// mark-and-sweep: objects of this stream not re-applied before its next `InitDone`
    /// were deleted during the outage.
    Restarted(StreamId),
    /// Initial list for this stream is complete.
    InitDone(StreamId),
    /// Watcher hit an error. `fatal` = permission denied (or a panicked watcher task), stopped.
    Failed {
        stream: StreamId,
        error: AppError,
        fatal: bool,
    },
    /// Watcher produced data again after an error.
    Recovered(StreamId),
    /// The cluster-wide watch of `kind` was forbidden; it now runs per namespace over
    /// `namespaces` (empty: nowhere, the kind is denied).
    FellBack { kind: Kind, namespaces: Vec<String> },
}
```

Then thread the stream through:
- `fn classify(stream: StreamId, e: &watcher::Error) -> StoreEvent` — same body, ending `StoreEvent::Failed { stream, error, fatal }`.
- `translate` gains `stream_id: StreamId` instead of `kind: Kind`, and returns how it ended:

```rust
/// How `translate` ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum End {
    /// The stream finished, the reducer is gone, or a fatal error was reported.
    Finished,
    /// A forbidden error, held back because the caller asked to fall back instead of reporting it.
    Forbidden,
}

async fn translate<K: IntoObject, S>(stream_id: StreamId, mut stream: S, tx: mpsc::Sender<StoreEvent>, hold_forbidden: bool) -> End
where
    S: Stream<Item = Result<Event<K>, watcher::Error>> + Unpin,
{
    let mut errored = false;
    while let Some(item) = stream.next().await {
        match item {
            Ok(ok_event) => {
                if errored {
                    errored = false;
                    if tx.send(StoreEvent::Recovered(stream_id.clone())).await.is_err() {
                        return End::Finished; // reducer gone
                    }
                }
                let ev = match ok_event {
                    Event::Init => StoreEvent::Restarted(stream_id.clone()),
                    Event::InitApply(obj) | Event::Apply(obj) => StoreEvent::Applied(obj.into_object()),
                    Event::Delete(obj) => StoreEvent::Deleted(obj.into_object().key()),
                    Event::InitDone => StoreEvent::InitDone(stream_id.clone()),
                };
                if tx.send(ev).await.is_err() {
                    return End::Finished; // reducer gone
                }
            }
            Err(e) => {
                tracing::warn!(kind = ?stream_id.kind, namespace = ?stream_id.namespace, error = %e, "watcher error");
                let ev = classify(stream_id.clone(), &e);
                let (fatal, forbidden) = match &ev {
                    StoreEvent::Failed { fatal, error, .. } => (*fatal, *fatal && error.kind == ErrorKind::Forbidden),
                    _ => (false, false),
                };
                if hold_forbidden && forbidden {
                    return End::Forbidden;
                }
                errored = true;
                if tx.send(ev).await.is_err() {
                    return End::Finished; // reducer gone
                }
                if fatal {
                    return End::Finished;
                }
            }
        }
    }
    End::Finished
}
```

- `spawn_supervised(stream: StreamId, fut, tx)` reports a panic as `StoreEvent::Failed { stream, error: AppError::internal(format!("{} watcher panicked", stream.kind.as_str())), fatal: true }` (log with `kind = ?stream.kind`).
- `spawn_watch<K: IntoObject>(api: Api<K>, stream: StreamId, tx)`:

```rust
pub fn spawn_watch<K: IntoObject>(api: Api<K>, stream_id: StreamId, tx: mpsc::Sender<StoreEvent>) -> JoinHandle<()> {
    let stream = watcher(api, watcher::Config::default()).default_backoff().boxed();
    let fut = {
        let (stream_id, tx) = (stream_id.clone(), tx.clone());
        async move {
            translate(stream_id, stream, tx, false).await;
        }
    };
    spawn_supervised(stream_id, fut, tx)
}
```

- `spawn_all` keeps its signature for now; its macro passes `StreamId::namespaced(<$ty as IntoObject>::KIND, namespace)` and the PV line `StreamId::cluster(Kind::PersistentVolume)`.

Update the watch tests: `classify(Kind::X, …)` → `classify(Kind::X.into(), …)`; `translate::<Pod, _>(Kind::Pod, stream, tx)` → `translate::<Pod, _>(Kind::Pod.into(), stream, tx, false)`; `spawn_supervised(Kind::Pod, …)` → `spawn_supervised(Kind::Pod.into(), …)`; pattern matches `StoreEvent::Restarted(Kind::Pod)` → `StoreEvent::Restarted(s) if s.kind == Kind::Pod` (likewise `InitDone`, `Recovered`); `StoreEvent::Failed { kind: Kind::Pod, fatal: false, .. }` → `StoreEvent::Failed { stream, fatal: false, .. } if stream.kind == Kind::Pod`; in `panicking_watcher_reports_fatal_failure` destructure `StoreEvent::Failed { stream, fatal, error }` and assert `stream.kind == Kind::Pod`.

Add a test:

```rust
    #[tokio::test]
    async fn a_held_forbidden_error_ends_without_being_reported() {
        let events: Vec<Result<Event<Pod>, watcher::Error>> = vec![Ok(Event::Init), Err(watcher::Error::InitialListFailed(api_error(403)))];
        let (tx, mut rx) = mpsc::channel(16);
        let end = translate::<Pod, _>(Kind::Pod.into(), futures::stream::iter(events), tx, true).await;
        assert_eq!(end, End::Forbidden);
        assert!(matches!(rx.recv().await, Some(StoreEvent::Restarted(_))));
        assert!(rx.recv().await.is_none(), "the 403 is not reported when held");
    }
```

- [ ] **Step 3: Reducer per stream** — in `reducer.rs` add `use super::scope::StreamId;`.

`ReducerConfig.kinds: Vec<Kind>` becomes `streams: Vec<StreamId>`; `Default` uses `Kind::WATCHED.iter().map(|k| StreamId::from(*k)).collect()`.

Add, above `spawn_reducer`:

```rust
/// What became of a stream the reducer waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamState {
    Pending,
    Live,
    Dead,
}

/// Mark `kind` denied when every one of its streams is dead, partial when only some are.
fn mark_kind(shared: &Shared, streams: &HashMap<StreamId, StreamState>, kind: Kind) {
    let states: Vec<StreamState> = streams.iter().filter(|(s, _)| s.kind == kind).map(|(_, st)| *st).collect();
    let dead = states.iter().filter(|st| **st == StreamState::Dead).count();
    if states.is_empty() || dead == states.len() {
        shared.partial_kinds().remove(&kind);
        shared.denied_kinds().insert(kind);
    } else if dead > 0 {
        shared.partial_kinds().insert(kind);
    }
}
```

In `run`: replace `init_pending: HashSet<Kind>` by `let mut streams: HashMap<StreamId, StreamState> = config.streams.iter().cloned().map(|s| (s, StreamState::Pending)).collect();`, `stale: HashMap<Kind, …>` by `HashMap<StreamId, HashSet<ObjectKey>>`, `errored_since: HashMap<Kind, Instant>` by `HashMap<StreamId, Instant>`; the initialised check becomes `!streams.values().any(|s| *s == StreamState::Pending)`. Pass `&mut streams` where `&mut init_pending` was passed.

`apply` / `apply_to_store` take `streams: &mut HashMap<StreamId, StreamState>`; the pod check uses `matches!(&ev, StoreEvent::InitDone(s) if s.kind == Kind::Pod)`. New `apply_to_store` match:

```rust
    match ev {
        StoreEvent::Applied(obj) => {
            let (kind, ns, key) = (obj.kind(), obj.namespace().map(str::to_owned), obj.key());
            errored_since.retain(|s, _| !(s.kind == kind && s.covers(ns.as_deref())));
            for (s, keys) in stale.iter_mut() {
                if s.kind == kind && s.covers(ns.as_deref()) {
                    keys.remove(&key);
                }
            }
            upsert_if_changed(shared, obj)
        }
        StoreEvent::Deleted(key) => {
            errored_since.retain(|s, _| !(s.kind == key.kind && s.covers(key.namespace.as_deref())));
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
            streams.insert(stream, StreamState::Live);
            swept
        }
        StoreEvent::Recovered(stream) => {
            errored_since.remove(&stream);
            false
        }
        StoreEvent::Failed { stream, error, fatal } => {
            if fatal {
                errored_since.remove(&stream);
                stale.remove(&stream);
                let kind = stream.kind;
                streams.insert(stream, StreamState::Dead);
                mark_kind(shared, streams, kind);
                emit_kind_error(emitter, kind, &error);
            } else if let Entry::Vacant(slot) = errored_since.entry(stream.clone()) {
                // Report the first failure of an outage so the user learns why nothing
                // arrives; the watcher keeps retrying, and repeats stay silent until the
                // stream recovers (any Applied/Deleted/InitDone/Recovered clears the entry).
                slot.insert(Instant::now());
                emit_kind_error(emitter, stream.kind, &error);
            }
            false
        }
        StoreEvent::FellBack { kind, namespaces } => {
            let cluster = StreamId::cluster(kind);
            streams.remove(&cluster);
            stale.remove(&cluster);
            errored_since.remove(&cluster);
            for ns in &namespaces {
                streams.insert(StreamId::namespaced(kind, ns), StreamState::Pending);
            }
            if namespaces.is_empty() {
                shared.denied_kinds().insert(kind);
            } else {
                shared.partial_kinds().insert(kind);
            }
            false
        }
    }
```

Note the `Failed` arm: `stream` is moved into `streams.insert` after `kind` is copied — keep that order. `HashSet` import stays (still used for keys).

Update reducer tests mechanically: `fast_config(kinds)` sets `streams: kinds.iter().map(|k| StreamId::from(*k)).collect()`; every `StoreEvent::InitDone(Kind::X)` → `StoreEvent::InitDone(Kind::X.into())`, same for `Restarted(Kind::X)` / `Recovered(Kind::X)`; every `StoreEvent::Failed { kind: Kind::X, …` → `StoreEvent::Failed { stream: Kind::X.into(), …`.

Add tests:

```rust
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

    #[tokio::test(start_paused = true)]
    async fn a_relist_of_one_namespace_does_not_sweep_another() {
        let a = StreamId::namespaced(Kind::Pod, "a");
        let b = StreamId::namespaced(Kind::Pod, "b");
        let shared = Shared::default();
        let (emitter, mut rx) = ChannelEmitter::new();
        let (tx, _h) = spawn_reducer(config_for(&[a.clone(), b.clone()]), shared.clone(), Arc::new(emitter));
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
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
        let (emitter, mut rx) = ChannelEmitter::new();
        let (tx, _h) = spawn_reducer(config_for(&[a.clone(), b.clone()]), shared.clone(), Arc::new(emitter));
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        let forbid = |s: StreamId| ReducerMsg::Store(StoreEvent::Failed { stream: s, error: AppError::new(ErrorKind::Forbidden, "no"), fatal: true });
        tx.send(forbid(a)).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert!(shared.partial_kinds().contains(&Kind::Secret));
        assert!(!shared.denied_kinds().contains(&Kind::Secret));
        tx.send(forbid(b)).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert!(shared.denied_kinds().contains(&Kind::Secret));
        assert!(!shared.partial_kinds().contains(&Kind::Secret));
    }

    #[tokio::test(start_paused = true)]
    async fn a_fallback_waits_for_the_per_namespace_streams() {
        let shared = Shared::default();
        let (emitter, mut rx) = ChannelEmitter::new();
        let (tx, _h) = spawn_reducer(config_for(&[StreamId::cluster(Kind::Pod)]), shared.clone(), Arc::new(emitter));
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        tx.send(ReducerMsg::Store(StoreEvent::Restarted(StreamId::cluster(Kind::Pod)))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::FellBack { kind: Kind::Pod, namespaces: vec!["a".into(), "b".into()] })).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(StreamId::namespaced(Kind::Pod, "a")))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(rx.try_recv().is_err(), "b has not listed yet");
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(StreamId::namespaced(Kind::Pod, "b")))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        assert!(shared.partial_kinds().contains(&Kind::Pod));
    }

    #[tokio::test(start_paused = true)]
    async fn a_fallback_with_no_namespace_denies_the_kind() {
        let shared = Shared::default();
        let (emitter, mut rx) = ChannelEmitter::new();
        let (tx, _h) = spawn_reducer(config_for(&[StreamId::cluster(Kind::Pod), StreamId::cluster(Kind::ConfigMap)]), shared.clone(), Arc::new(emitter));
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        tx.send(ReducerMsg::Store(StoreEvent::FellBack { kind: Kind::Pod, namespaces: vec![] })).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::ConfigMap.into()))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        assert!(shared.denied_kinds().contains(&Kind::Pod));
    }
```

- [ ] **Step 4: Session builds the config** — in `session/mod.rs` `select_namespace`, replace `ReducerConfig::default()` with:

```rust
        let plan = scope::watch_plan(&scope::NamespaceScope::single(namespace));
        let config = ReducerConfig {
            streams: plan,
            ..Default::default()
        };
```

and pass `config` to `spawn_reducer`.

- [ ] **Step 5: Run** — `cd src-tauri && cargo test --lib session && cargo clippy --all-targets -- -D warnings && cargo fmt --check && cargo test` → PASS (all existing reducer/watch tests plus the new ones).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/session/watch.rs src-tauri/src/session/reducer.rs src-tauri/src/session/shared.rs src-tauri/src/session/mod.rs
git commit -m "$(cat <<'EOF'
Track watch streams per namespace in the reducer, with partial kinds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 3: Spawn the watch plan, with the cluster-wide fallback

**Files:**
- Modify: `src-tauri/src/session/watch.rs`, `src-tauri/src/session/mod.rs`

`Api::namespaced` needs `K: Resource<Scope = NamespaceResourceScope>`, so namespaced kinds and PersistentVolume take different generic paths.

- [ ] **Step 1: Failing test** — add to `watch.rs` tests:

```rust
    #[test]
    fn every_planned_stream_can_be_spawned() {
        // spawn_stream must handle every watched kind (it would hit the `PodGroup` fallback otherwise).
        for kind in Kind::WATCHED {
            assert!(super::is_spawnable(kind), "{kind:?}");
        }
        assert!(!super::is_spawnable(Kind::PodGroup));
    }
```

Run `cd src-tauri && cargo test --lib session::watch` → FAIL (no `is_spawnable`).

- [ ] **Step 2: Implement** — in `watch.rs` replace `spawn_all` with:

```rust
/// The `All` scope for one namespaced kind: a cluster-wide watch; if RBAC forbids it, one watch
/// per namespace in `namespaces` instead, announced with `FellBack` so the reducer waits for them.
/// The per-namespace watches run inside this task, so aborting it stops them too.
async fn cluster_or_per_namespace<K>(client: Client, namespaces: Vec<String>, tx: mpsc::Sender<StoreEvent>)
where
    K: IntoObject + Resource<Scope = k8s_openapi::NamespaceResourceScope>,
{
    let all = watcher(Api::<K>::all(client.clone()), watcher::Config::default()).default_backoff().boxed();
    if translate(StreamId::cluster(K::KIND), all, tx.clone(), true).await != End::Forbidden {
        return;
    }
    if tx
        .send(StoreEvent::FellBack {
            kind: K::KIND,
            namespaces: namespaces.clone(),
        })
        .await
        .is_err()
    {
        return;
    }
    let per_namespace = namespaces.into_iter().map(|ns| {
        let stream = watcher(Api::<K>::namespaced(client.clone(), &ns), watcher::Config::default()).default_backoff().boxed();
        translate(StreamId::namespaced(K::KIND, &ns), stream, tx.clone(), false)
    });
    futures::future::join_all(per_namespace).await;
}

/// One namespaced kind's stream: its namespace, or cluster-wide with the fallback above.
fn spawn_namespaced<K>(client: &Client, stream: &StreamId, namespaces: &[String], tx: &mpsc::Sender<StoreEvent>) -> JoinHandle<()>
where
    K: IntoObject + Resource<Scope = k8s_openapi::NamespaceResourceScope>,
{
    match &stream.namespace {
        Some(ns) => spawn_watch(Api::<K>::namespaced(client.clone(), ns), stream.clone(), tx.clone()),
        None => spawn_supervised(
            stream.clone(),
            cluster_or_per_namespace::<K>(client.clone(), namespaces.to_vec(), tx.clone()),
            tx.clone(),
        ),
    }
}

/// Whether `spawn_stream` has a watcher for `kind`.
fn is_spawnable(kind: Kind) -> bool {
    kind != Kind::PodGroup
}

fn spawn_stream(client: &Client, stream: &StreamId, namespaces: &[String], tx: &mpsc::Sender<StoreEvent>) -> JoinHandle<()> {
    use k8s_openapi::api::{
        apps::v1 as apps, autoscaling::v2 as autoscaling, batch::v1 as batch, core::v1 as core, networking::v1 as networking,
    };
    match stream.kind {
        Kind::Deployment => spawn_namespaced::<apps::Deployment>(client, stream, namespaces, tx),
        Kind::StatefulSet => spawn_namespaced::<apps::StatefulSet>(client, stream, namespaces, tx),
        Kind::DaemonSet => spawn_namespaced::<apps::DaemonSet>(client, stream, namespaces, tx),
        Kind::ReplicaSet => spawn_namespaced::<apps::ReplicaSet>(client, stream, namespaces, tx),
        Kind::Job => spawn_namespaced::<batch::Job>(client, stream, namespaces, tx),
        Kind::CronJob => spawn_namespaced::<batch::CronJob>(client, stream, namespaces, tx),
        Kind::Pod => spawn_namespaced::<core::Pod>(client, stream, namespaces, tx),
        Kind::Service => spawn_namespaced::<core::Service>(client, stream, namespaces, tx),
        Kind::Ingress => spawn_namespaced::<networking::Ingress>(client, stream, namespaces, tx),
        Kind::ConfigMap => spawn_namespaced::<core::ConfigMap>(client, stream, namespaces, tx),
        Kind::Secret => spawn_namespaced::<core::Secret>(client, stream, namespaces, tx),
        Kind::PersistentVolumeClaim => spawn_namespaced::<core::PersistentVolumeClaim>(client, stream, namespaces, tx),
        Kind::ServiceAccount => spawn_namespaced::<core::ServiceAccount>(client, stream, namespaces, tx),
        Kind::HorizontalPodAutoscaler => spawn_namespaced::<autoscaling::HorizontalPodAutoscaler>(client, stream, namespaces, tx),
        Kind::PersistentVolume => spawn_watch(Api::<core::PersistentVolume>::all(client.clone()), stream.clone(), tx.clone()),
        // Never planned (see `watch_plan`); a finished task keeps the caller's bookkeeping simple.
        Kind::PodGroup => tokio::spawn(async {}),
    }
}

/// Start a watcher for every stream of `plan`. `namespaces` are the namespaces the user can list:
/// a forbidden cluster-wide stream falls back to them.
pub fn spawn_plan(client: &Client, plan: &[StreamId], namespaces: &[String], tx: &mpsc::Sender<StoreEvent>) -> Vec<JoinHandle<()>> {
    plan.iter().map(|s| spawn_stream(client, s, namespaces, tx)).collect()
}
```

In `session/mod.rs` `select_namespace`: keep `plan` in a variable (clone it into the config) and replace `self.tasks = spawn_all(&self.client, namespace, &store_tx);` with `self.tasks = watch::spawn_plan(&self.client, &plan, &[], &store_tx);`; drop the `use watch::spawn_all;` import.

- [ ] **Step 3: Run** — `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/session/watch.rs src-tauri/src/session/mod.rs
git commit -m "$(cat <<'EOF'
Spawn watchers from the watch plan, falling back per namespace when cluster-wide is forbidden

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 4: Metrics per scope, keyed by namespace and name

**Files:**
- Modify: `src-tauri/src/metrics/mod.rs`, `src-tauri/src/metrics/sample.rs`, `src-tauri/src/metrics/usage.rs`, `src-tauri/src/session/metrics.rs`, `src-tauri/src/session/mod.rs`

- [ ] **Step 1: Failing test** — in `metrics/sample.rs` tests:

```rust
    #[test]
    fn pods_with_the_same_name_in_two_namespaces_stay_apart() {
        let item = |ns: &str, cpu: &str| json!({ "metadata": { "name": "web", "namespace": ns }, "containers": [
            { "name": "app", "usage": { "cpu": cpu, "memory": "1Mi" } } ] });
        let pods = parse_pod_metrics(&[item("a", "10m"), item("b", "20m")]);
        assert_eq!(pods["a/web"].cpu_millis, 10);
        assert_eq!(pods["b/web"].cpu_millis, 20);
        assert_eq!(crate::metrics::pod_key(None, "web"), "web");
        assert_eq!(crate::metrics::pod_key(Some("a"), "web"), "a/web");
    }
```

Run `cd src-tauri && cargo test --lib metrics::sample` → FAIL (`pod_key` missing; one `web` key).

- [ ] **Step 2: Implement**
  - `metrics/mod.rs`:

```rust
/// The key of a pod in `MetricsSample::pods`: `namespace/name`, or just the name when the item
/// carries no namespace. Two namespaces can hold pods of the same name.
pub fn pod_key(namespace: Option<&str>, name: &str) -> String {
    match namespace {
        Some(ns) if !ns.is_empty() => format!("{ns}/{name}"),
        _ => name.to_string(),
    }
}
```

and change the `pods` field doc to `/// Usage per pod, keyed by [`pod_key`].`.
  - `sample.rs`: inside the closure read `let namespace = item.pointer("/metadata/namespace").and_then(Value::as_str);` and return `Some((super::pod_key(namespace, &name), total))`; update the doc to "Usage per pod (keyed by `pod_key`)".
  - `usage.rs`: line ~80 → `.filter_map(|p| p.metadata.name.as_deref().and_then(|n| store.metrics.pods.get(&super::pod_key(p.metadata.namespace.as_deref(), n))))`; line ~114 → `.filter(|p| p.metadata.name.as_deref().is_some_and(|n| store.metrics.pods.contains_key(&super::pod_key(p.metadata.namespace.as_deref(), n))))` (adjust `super::` to `crate::metrics::` if `usage` is not a direct child).
  - `usage.rs` tests that build `MetricsSample.pods` from store pods must use the pods' namespace: in `sampled()` change `.map(|(n, u)| (n.to_string(), u))` to `.map(|(n, u)| (format!("m/{n}"), u))` (the `metrics` fixture is namespace `m`); the `web-0` test (~396) uses the namespace of its `pod(...)` helper (`"<ns>/web-0"`); the native-sidecar test (~471) uses `"m/p"`. JSON-item tests in `sample.rs` / `session/metrics.rs` have no namespace and keep their bare keys.
  - `session/metrics.rs` `spawn` takes the scope:

```rust
/// The live poller for `scope`. It is pushed to the namespace session's tasks, so a scope
/// switch or disconnect aborts it with the watchers.
pub fn spawn(client: Client, scope: &NamespaceScope, shared: Shared, reducer: mpsc::Sender<ReducerMsg>, emitter: Arc<dyn Emitter>) -> JoinHandle<()> {
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", "PodMetrics"), "pods");
    let apis: Vec<Api<DynamicObject>> = match scope {
        NamespaceScope::All => vec![Api::all_with(client, &ar)],
        NamespaceScope::Set(set) => set.iter().map(|ns| Api::namespaced_with(client.clone(), ns, &ar)).collect(),
    };
    tokio::spawn(run(
        move || {
            let apis = apis.clone();
            async move {
                // One list per namespace of a set; the first failure answers for the whole tick.
                let mut items = Vec::new();
                for api in apis {
                    let list = api.list(&ListParams::default()).await?;
                    items.extend(list.items.into_iter().filter_map(|o| serde_json::to_value(o).ok()));
                }
                Ok(items)
            }
        },
        shared,
        reducer,
        emitter,
        POLL_PERIOD,
    ))
}
```

with `use super::scope::NamespaceScope;`.
  - `session/mod.rs`: the call becomes `metrics::spawn(self.client.clone(), &scope::NamespaceScope::single(namespace), …)`.

- [ ] **Step 3: Run** — `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/metrics src-tauri/src/session/metrics.rs src-tauri/src/session/mod.rs
git commit -m "$(cat <<'EOF'
Poll pod metrics per namespace scope and key them by namespace and name

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 5: `select_scope`, `select_namespaces` and `partial_kinds`

**Files:**
- Modify: `src-tauri/src/session/mod.rs`, `src-tauri/src/commands.rs`

- [ ] **Step 1: Session state** — add fields to `Session`:

```rust
    /// What the namespace session watches (`None` before the first selection).
    scope: Option<scope::NamespaceScope>,
    /// The namespaces `connect` could list; a forbidden cluster-wide watch falls back to them.
    namespaces: Vec<String>,
```

initialised `None` / `Vec::new()` in `Session::new`. In `connect`, replace `Ok((Session::new(client, emitter), info))` with:

```rust
        let mut session = Session::new(client, emitter);
        session.namespaces = info.namespaces.clone();
        Ok((session, info))
```

- [ ] **Step 2: `select_scope`** — replace `select_namespace` with:

```rust
    /// Tear down any previous watchers and start watching `scope`.
    pub async fn select_scope(&mut self, scope: scope::NamespaceScope, expanded_groups: HashSet<NodeId>) -> AppResult<()> {
        self.execs.stop_all().await;
        self.stop_watchers();
        self.shared = Shared::default();
        *self.shared.expanded_groups() = expanded_groups;
        self.ns_emitter = ClosableEmitter::new(self.emitter.clone());

        let plan = scope::watch_plan(&scope);
        let config = ReducerConfig {
            streams: plan.clone(),
            ..Default::default()
        };
        let (reducer_tx, reducer_task) = spawn_reducer(config, self.shared.clone(), Arc::new(self.ns_emitter.clone()));
        let (store_tx, mut store_rx) = mpsc::channel(4096);
        // Bridge StoreEvent -> ReducerMsg so watchers do not know about the reducer.
        let bridge_tx = reducer_tx.clone();
        let bridge = tokio::spawn(async move {
            while let Some(ev) = store_rx.recv().await {
                if bridge_tx.send(ReducerMsg::Store(ev)).await.is_err() {
                    break;
                }
            }
        });
        self.tasks = watch::spawn_plan(&self.client, &plan, &self.namespaces, &store_tx);
        self.tasks.push(metrics::spawn(
            self.client.clone(),
            &scope,
            self.shared.clone(),
            reducer_tx.clone(),
            Arc::new(self.ns_emitter.clone()),
        ));
        self.tasks.push(bridge);
        self.tasks.push(reducer_task);
        self.reducer_tx = Some(reducer_tx);
        self.scope = Some(scope);
        Ok(())
    }

    /// One namespace: the pre-scope entry point (removed once the frontend selects scopes).
    pub async fn select_namespace(&mut self, namespace: &str, expanded_groups: HashSet<NodeId>) -> AppResult<()> {
        self.select_scope(scope::NamespaceScope::single(namespace), expanded_groups).await
    }

    pub fn partial_kinds(&self) -> Vec<Kind> {
        let mut v: Vec<Kind> = self.shared.partial_kinds().iter().copied().collect();
        v.sort();
        v
    }
```

- [ ] **Step 3: Commands** — in `commands.rs` add (next to `select_namespace` / `denied_kinds`):

```rust
/// `namespaces: null` watches all namespaces; a list watches those.
#[tauri::command]
pub async fn select_namespaces(state: State<'_, AppState>, namespaces: Option<Vec<String>>, expanded_groups: Vec<String>) -> AppResult<()> {
    let scope = crate::session::scope::NamespaceScope::from_arg(namespaces)?;
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.select_scope(scope, expanded_groups.into_iter().collect::<HashSet<_>>()).await
}

#[tauri::command]
pub async fn partial_kinds(state: State<'_, AppState>) -> AppResult<Vec<Kind>> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    Ok(session.partial_kinds())
}
```

and register `select_namespaces` and `partial_kinds` in `generate_handler!` (after `select_namespace` / `denied_kinds`).

- [ ] **Step 4: Test** — the scope plumbing is covered by `scope` and reducer tests and, end to end, by the smoke (Task 9). Add a unit test in `session/mod.rs` that a fresh session reports no partial kinds and accepts a scope without a cluster:

```rust
    #[tokio::test]
    async fn a_session_takes_a_scope_without_waiting_for_the_cluster() {
        use crate::session::emitter::ChannelEmitter;
        let (emitter, _rx) = ChannelEmitter::new();
        let client = Client::try_from(Config::new("https://127.0.0.1:1".parse().unwrap())).unwrap();
        let mut session = Session::new(client, Arc::new(emitter));
        session.select_scope(scope::NamespaceScope::All, HashSet::new()).await.unwrap();
        assert_eq!(session.scope, Some(scope::NamespaceScope::All));
        assert!(session.partial_kinds().is_empty());
        session.shutdown().await;
    }
```

Run `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/session/mod.rs src-tauri/src/commands.rs
git commit -m "$(cat <<'EOF'
Select several namespaces or all of them, and report partially watched kinds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 6: The too-large graph guard

**Files:**
- Modify: `src-tauri/src/graph/model.rs`, `src-tauri/src/session/shared.rs`, `src-tauri/src/session/reducer.rs`, `src-tauri/tests/ipc_fixtures.rs` (the `Graph { … }` literal gets `too_large: None`)

- [ ] **Step 1: Failing tests** — in `model.rs` tests:

```rust
    #[test]
    fn a_summarised_graph_keeps_only_counts() {
        let mut full = Graph::default();
        for i in 0..3 {
            full.nodes.push(Node {
                id: format!("ConfigMap/n/c{i}"),
                kind: Kind::ConfigMap,
                namespace: Some("n".into()),
                name: format!("c{i}"),
                status: if i == 0 { Status::Warn } else { Status::Ok },
                badges: vec![],
                group: None,
                problem: None,
            });
        }
        full.nodes.push(Node {
            id: "PodGroup/n/Deployment/web".into(),
            kind: Kind::PodGroup,
            namespace: Some("n".into()),
            name: "web".into(),
            status: Status::Ok,
            badges: vec![],
            group: Some(GroupInfo { count: 7, ok: 7, warn: 0, err: 0 }),
            problem: None,
        });
        let s = Graph::summarised(&full);
        assert!(s.nodes.is_empty() && s.edges.is_empty());
        let t = s.too_large.unwrap();
        assert_eq!(t.nodes, 4);
        assert_eq!(
            t.kinds,
            vec![
                KindStat { kind: Kind::Pod, count: 7, worst: Status::Ok },
                KindStat { kind: Kind::ConfigMap, count: 3, worst: Status::Warn },
            ]
        );
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["tooLarge"]["nodes"], 4);
        assert!(serde_json::to_value(Graph::default()).unwrap().get("tooLarge").is_none());
    }
```

(`Kind` derives `Ord` in declaration order — Pod before ConfigMap — so the `BTreeMap` order above is `Pod, ConfigMap`.)

In `reducer.rs` tests:

```rust
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
        assert!(rx.try_recv().is_err(), "nothing changed");
        shared.store().remove(&cm("c0").key());
        shared.store().remove(&cm("c1").key());
        emit_rebuild(&shared, &emitter);
        assert!(matches!(rx.try_recv().unwrap(), OutEvent::GraphSnapshot(g) if g.too_large.is_none() && g.nodes.len() == crate::graph::MAX_GRAPH_NODES - 1));
    }
```

Run `cd src-tauri && cargo test --lib graph::model session::reducer` → FAIL to compile.

- [ ] **Step 2: Implement**
  - `model.rs`:

```rust
/// Above this many nodes the graph is not sent; the frontend shows tables instead.
pub const MAX_GRAPH_NODES: usize = 1500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindStat {
    pub kind: Kind,
    pub count: usize,
    pub worst: Status,
}

/// Sent instead of the nodes of a graph with more than `MAX_GRAPH_NODES` nodes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TooLarge {
    pub nodes: usize,
    pub kinds: Vec<KindStat>,
}
```

`Graph` gains:

```rust
    #[serde(rename = "tooLarge", default, skip_serializing_if = "Option::is_none")]
    pub too_large: Option<TooLarge>,
```

and `impl Graph` gains:

```rust
    /// What crosses IPC instead of `full` when it is too large: no nodes or edges, only the node
    /// count and per-kind totals (a PodGroup counts its pods as Pods) for the navigator.
    pub fn summarised(full: &Graph) -> Graph {
        let mut by_kind: std::collections::BTreeMap<Kind, (usize, Status)> = std::collections::BTreeMap::new();
        for n in &full.nodes {
            let (kind, count) = match (n.kind, &n.group) {
                (Kind::PodGroup, group) => (Kind::Pod, group.as_ref().map_or(0, |g| g.count)),
                (kind, _) => (kind, 1),
            };
            let entry = by_kind.entry(kind).or_insert((0, Status::Unknown));
            entry.0 += count;
            entry.1 = entry.1.max(n.status);
        }
        Graph {
            nodes: vec![],
            edges: vec![],
            too_large: Some(TooLarge {
                nodes: full.nodes.len(),
                kinds: by_kind.into_iter().map(|(kind, (count, worst))| KindStat { kind, count, worst }).collect(),
            }),
        }
    }
```

Fix the one `Graph { nodes, edges }` literal in `build.rs` (`..Default::default()` or `too_large: None`) and in `tests/ipc_fixtures.rs`.
  - `shared.rs` `rebuild`:

```rust
    pub(crate) fn rebuild(&self) -> (Graph, GraphDelta) {
        let mut new = build(&self.store(), &self.build_options());
        if new.nodes.len() > crate::graph::MAX_GRAPH_NODES {
            new = Graph::summarised(&new);
        }
        let mut last = self.graph();
        let delta = diff(&last, &new);
        *last = new.clone();
        (new, delta)
    }
```

  - `reducer.rs` `emit_rebuild`:

```rust
/// A change of the too-large state (or of its counts) goes out as a snapshot: deltas cannot say
/// "the graph is not sent any more".
fn emit_rebuild(shared: &Shared, emitter: &Arc<dyn Emitter>) {
    let before = shared.graph().too_large.clone();
    let (graph, delta) = shared.rebuild();
    if graph.too_large != before {
        emitter.emit(OutEvent::GraphSnapshot(graph));
    } else if !delta.is_empty() {
        emitter.emit(OutEvent::GraphDelta(delta));
    }
}
```

- [ ] **Step 3: Run** — `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/graph src-tauri/src/session/shared.rs src-tauri/src/session/reducer.rs src-tauri/tests/ipc_fixtures.rs
git commit -m "$(cat <<'EOF'
Replace graphs over 1500 nodes with per-kind counts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 7: The Namespace column in tables

**Files:**
- Modify: `src-tauri/src/graph/rows.rs`, `src-tauri/src/session/mod.rs`

- [ ] **Step 1: Failing test** — in `rows.rs` tests:

```rust
    #[test]
    fn a_namespace_column_leads_and_rows_sort_by_namespace_then_name() {
        let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: z, namespace: a }\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: b, namespace: b }\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: a, namespace: b }\n";
        let store = Store::from_yaml_docs(yaml).unwrap();
        let t = with_namespace_column(table(&store, Kind::ConfigMap, jiff::Timestamp::now()));
        assert_eq!(t.columns[0].key, "namespace");
        assert_eq!(t.columns[1].key, "name");
        let rows: Vec<(String, String)> = t.rows.iter().map(|r| (r.cells[0].text.clone(), r.cells[1].text.clone())).collect();
        assert_eq!(rows, vec![("a".into(), "z".into()), ("b".into(), "a".into()), ("b".into(), "b".into())]);
        let pv = Store::from_yaml_docs("apiVersion: v1\nkind: PersistentVolume\nmetadata: { name: pv-1 }\n").unwrap();
        let t = with_namespace_column(table(&pv, Kind::PersistentVolume, jiff::Timestamp::now()));
        assert_eq!(t.rows[0].cells[0].text, "—");
    }
```

Run → FAIL (`with_namespace_column` missing).

- [ ] **Step 2: Implement** — in `rows.rs`:

```rust
/// `table` with a leading Namespace column, for a scope of several namespaces; rows sort by
/// namespace, then name. Cluster-scoped objects show `—`.
pub fn with_namespace_column(mut table: Table) -> Table {
    table.columns.insert(0, col("namespace", "Namespace", false));
    for row in &mut table.rows {
        let ns = row.node_id.split('/').nth(1).unwrap_or_default();
        row.cells.insert(0, plain(if ns.is_empty() { "—" } else { ns }));
    }
    table
        .rows
        .sort_by(|a, b| (&a.cells[0].text, &a.cells[1].text).cmp(&(&b.cells[0].text, &b.cells[1].text)));
    table
}
```

In `session/mod.rs`:

```rust
    pub fn list_rows(&self, kind: Kind) -> Table {
        let table = {
            let store = self.shared.store();
            crate::graph::rows::table(&store, kind, k8s_openapi::jiff::Timestamp::now())
        };
        if self.scope.as_ref().is_some_and(scope::NamespaceScope::is_multi) {
            crate::graph::rows::with_namespace_column(table)
        } else {
            table
        }
    }
```

- [ ] **Step 3: Run** — `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/graph/rows.rs src-tauri/src/session/mod.rs
git commit -m "$(cat <<'EOF'
Lead tables with a Namespace column when several namespaces are shown

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 8: IPC contract and fixtures

**Files:**
- Create: `src/shared/ipc/fixtures/graph_too_large.json`
- Modify: `docs/ipc-contract.md`, `src-tauri/tests/ipc_fixtures.rs`

- [ ] **Step 1: Fixture**

```json
{"nodes":[],"edges":[],"tooLarge":{"nodes":1873,"kinds":[{"kind":"Deployment","count":120,"worst":"warn"},{"kind":"Pod","count":1500,"worst":"err"}]}}
```

- [ ] **Step 2: Failing test** — in `ipc_fixtures.rs` (import `KindStat, TooLarge` from `wiring_lib::graph`):

```rust
#[test]
fn graph_too_large() {
    assert_matches(
        "graph_too_large",
        &Graph {
            nodes: vec![],
            edges: vec![],
            too_large: Some(TooLarge {
                nodes: 1873,
                kinds: vec![
                    KindStat { kind: Kind::Deployment, count: 120, worst: Status::Warn },
                    KindStat { kind: Kind::Pod, count: 1500, worst: Status::Err },
                ],
            }),
        },
    );
}
```

Run `cd src-tauri && cargo test --test ipc_fixtures` (fails until the fixture file exists — create it in Step 1 *after* seeing the failure).

- [ ] **Step 3: Contract doc** — in `docs/ipc-contract.md`:
  - Commands table: add after `select_namespace`:
    `| select_namespaces | { namespaces: string[] \| null, expandedGroups: string[] } | null — null watches all namespaces; a list watches those (trimmed, deduplicated, each a DNS-1123 name; an empty list rejects with invalid). The graph arrives via events. |`
    and after `denied_kinds`:
    `| partial_kinds | — | Kind[] — kinds watched in some namespaces but forbidden in others (or forbidden cluster-wide and watched per namespace instead) |`
  - Mark `select_namespace` as "one namespace; same as `select_namespaces` with `[namespace]`".
  - Under the `graph_snapshot` row add: "When the graph has more than 1 500 nodes the snapshot is `{ nodes: [], edges: [], tooLarge: { nodes, kinds: [{ kind, count, worst }] } }` (a PodGroup counts its pods under `Pod`); every change of `tooLarge` (entering, leaving, or new counts) arrives as a new snapshot, never as a delta."
  - Table section: "With several namespaces selected `list_rows` returns a leading `namespace` column (`—` for cluster-scoped kinds) and rows sorted by namespace, then name."
  - Ordering rules: "After `select_namespace(s)`, clear the graph …"; "A snapshot whose namespaced nodes fall outside the current selection belongs to the previous one and is ignored."
  - Settings section: `lastScope: { [context]: "all" | string[] }` (supersedes `lastNamespace`, still read once for migration).

- [ ] **Step 4: Run** — `cd src-tauri && cargo test --test ipc_fixtures && cargo fmt --check` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc/fixtures/graph_too_large.json src-tauri/tests/ipc_fixtures.rs docs/ipc-contract.md
git commit -m "$(cat <<'EOF'
Document select_namespaces, partial_kinds and the too-large graph

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 9: Smoke test across namespaces

**Files:**
- Create: `src-tauri/tests/fixtures/smoke-b.yaml`
- Modify: `src-tauri/tests/smoke.rs`

The smoke runs ONLY with `WIRING_SMOKE_CONTEXT=docker-desktop`. It must not depend on anything in the cluster except `kube-system` existing.

- [ ] **Step 1: Second fixture namespace** — `smoke-b.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: wiring-smoke-b }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: b-cfg, namespace: wiring-smoke-b }
data: { k: v }
```

- [ ] **Step 2: Setup / teardown** — in `graph_snapshot_reflects_applied_fixture`: add `const NAMESPACE_B: &str = "wiring-smoke-b";` next to `NAMESPACE`; in setup also `kubectl(&context, &["delete", "namespace", NAMESPACE_B, "--ignore-not-found", "--wait=true"]);` and `kubectl(&context, &["apply", "-f", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/smoke-b.yaml")]);`; replace `session.select_namespace(NAMESPACE, HashSet::new())` with `session.select_scope(NamespaceScope::single(NAMESPACE), HashSet::new())` (`use wiring_lib::session::scope::NamespaceScope;`); in teardown also delete `NAMESPACE_B` (`--wait=false`).

- [ ] **Step 3: `exercise_scopes`** — add and call it **last** (after `exercise_metrics`, before `session.shutdown()`), with `phases.done("scopes")`:

```rust
/// Two namespaces in one graph and one table, then all namespaces.
async fn exercise_scopes(session: &mut Session, rx: &mut UnboundedReceiver<OutEvent>, graph: &mut Graph) {
    let both = NamespaceScope::from_arg(Some(vec![NAMESPACE.into(), NAMESPACE_B.into()])).unwrap();
    session.select_scope(both, HashSet::new()).await.unwrap();
    *graph = Graph::default();
    let b_cfg = format!("ConfigMap/{NAMESPACE_B}/b-cfg");
    let web = format!("Deployment/{NAMESPACE}/web");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let ok = graph_until(rx, graph, deadline, |g| has_node(g, &b_cfg) && has_node(g, &web)).await;
    assert!(ok, "both namespaces in one graph: {:?}", graph.nodes.iter().map(|n| &n.id).collect::<Vec<_>>());
    let table = session.list_rows(Kind::ConfigMap);
    assert_eq!(table.columns[0].key, "namespace", "{:?}", table.columns);
    assert!(table.rows.iter().any(|r| r.cells[0].text == NAMESPACE_B), "{:?}", table.rows);

    session.select_scope(NamespaceScope::All, HashSet::new()).await.unwrap();
    *graph = Graph::default();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let ok = graph_until(rx, graph, deadline, |g| {
        g.too_large.is_some() || g.nodes.iter().any(|n| n.namespace.as_deref() == Some("kube-system"))
    })
    .await;
    assert!(ok, "kube-system objects with all namespaces: {} nodes", graph.nodes.len());
}
```

(Use whatever `Kind` / `Duration` imports `smoke.rs` already has; add them if missing.)

- [ ] **Step 4: Run** — `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored --nocapture 2>&1 | tee /tmp/claude-smoke-scopes.log` → `1 passed` (run twice).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests/fixtures/smoke-b.yaml src-tauri/tests/smoke.rs
git commit -m "$(cat <<'EOF'
Smoke-test two namespaces in one graph and table, then all namespaces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 10: Frontend IPC types, scope helpers and settings

**Files:**
- Create: `src/shared/scope.ts`, `src/shared/scope.test.ts`
- Modify: `src/shared/ipc/types.ts`, `src/shared/ipc/commands.ts`, `src/shared/ipc/fixtures.test.ts`, `src/shared/settings.ts`, `src/shared/settings.test.ts`

- [ ] **Step 1: Failing tests**
  - `fixtures.test.ts`: `import graphTooLarge from "./fixtures/graph_too_large.json";` and
    `it("graph_too_large", () => expect(isGraph(graphTooLarge)).toBe(true));`
    `it("rejects a graph with a broken tooLarge", () => expect(isGraph({ nodes: [], edges: [], tooLarge: { nodes: "many", kinds: [] } })).toBe(false));`
  - `scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { firstNamespace, inScope, isMulti, scopeLabel } from "./scope";

describe("namespace scope helpers", () => {
  it("labels a scope", () => {
    expect(scopeLabel(null, [])).toBeNull();
    expect(scopeLabel(["shop"], [])).toBe("shop");
    expect(scopeLabel(["shop", "blog"], [])).toBe("shop, blog");
    expect(scopeLabel("all", ["a", "b", "c"])).toBe("All namespaces (3)");
    expect(scopeLabel("all", [])).toBe("All namespaces");
  });
  it("knows when several namespaces are shown", () => {
    expect(isMulti(null)).toBe(false);
    expect(isMulti(["a"])).toBe(false);
    expect(isMulti(["a", "b"])).toBe(true);
    expect(isMulti("all")).toBe(true);
  });
  it("tells whether a namespace is in scope", () => {
    expect(inScope("all", "x")).toBe(true);
    expect(inScope(["a"], "a")).toBe(true);
    expect(inScope(["a"], "b")).toBe(false);
    expect(inScope(null, "a")).toBe(false);
  });
  it("picks a namespace to create in", () => {
    expect(firstNamespace(["b", "a"], ["a", "b"])).toBe("b");
    expect(firstNamespace("all", ["a", "b"])).toBe("a");
    expect(firstNamespace("all", [])).toBeNull();
    expect(firstNamespace(null, ["a"])).toBeNull();
  });
});
```

  - `settings.test.ts` (extend the existing store mock): `setLastScope("ctx", ["a","b"])` then `getLastScope("ctx")` → `["a","b"]`; `setLastScope("ctx", "all")` → `"all"`; with only a legacy `lastNamespace: { ctx: "shop" }` stored, `getLastScope("ctx")` → `["shop"]`; garbage (`lastScope: { ctx: 42 }`) → falls back to legacy / `null`.

Run `pnpm test -- src/shared` → FAIL.

- [ ] **Step 2: Implement**
  - `types.ts`:

```ts
/** Which namespaces the session watches: all of them, or a non-empty list. */
export type NamespaceScope = "all" | string[];

export interface KindStat { kind: Kind; count: number; worst: Status }
/** Sent instead of the nodes of a graph with more than 1 500 nodes. */
export interface TooLarge { nodes: number; kinds: KindStat[] }

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; tooLarge?: TooLarge }
```

and guards:

```ts
function isKindStat(v: unknown): v is KindStat {
  return isObj(v) && oneOf(KINDS, v.kind) && typeof v.count === "number" && oneOf(STATUSES, v.worst);
}
export function isTooLarge(v: unknown): v is TooLarge {
  return isObj(v) && typeof v.nodes === "number" && arrayOf(v.kinds, isKindStat);
}
export function isGraph(v: unknown): v is Graph {
  return isObj(v) && arrayOf(v.nodes, isGraphNode) && arrayOf(v.edges, isGraphEdge) && (v.tooLarge === undefined || isTooLarge(v.tooLarge));
}
```

  - `commands.ts`:

```ts
  selectNamespaces: (scope: NamespaceScope, expandedGroups: NodeId[]) =>
    call<null>("select_namespaces", { namespaces: scope === "all" ? null : scope, expandedGroups }),
  partialKinds: () => call<Kind[]>("partial_kinds"),
```

  - `src/shared/scope.ts`:

```ts
import type { NamespaceScope } from "./ipc/types";

/** The header/caption text for a scope; `null` before any selection. */
export function scopeLabel(scope: NamespaceScope | null, known: string[]): string | null {
  if (scope === null) return null;
  if (scope === "all") return known.length > 0 ? `All namespaces (${known.length})` : "All namespaces";
  return scope.join(", ");
}

/** Several namespaces on screen: lanes in the graph, a Namespace column in tables. */
export function isMulti(scope: NamespaceScope | null): boolean {
  return scope === "all" || (scope !== null && scope.length > 1);
}

export function inScope(scope: NamespaceScope | null, namespace: string): boolean {
  return scope === "all" || (scope !== null && scope.includes(namespace));
}

/** Where **+ Create** puts an object by default: the first selected namespace (the first known one for All). */
export function firstNamespace(scope: NamespaceScope | null, known: string[]): string | null {
  if (scope === null) return null;
  if (scope === "all") return known[0] ?? null;
  return scope[0] ?? null;
}
```

  - `settings.ts`: add `"lastScope"` to the key unions; add

```ts
type ScopeMap = Record<string, NamespaceScope>;
const isScope = (v: unknown): v is NamespaceScope =>
  v === "all" || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string"));
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
```

and in `settings`:

```ts
  /** The context's remembered scope; a pre-scope `lastNamespace` string counts as a one-namespace scope. */
  async getLastScope(context: string): Promise<NamespaceScope | null> {
    const scopes = await settings.get<unknown>("lastScope");
    const remembered = isMap(scopes) ? scopes[context] : undefined;
    if (isScope(remembered)) return remembered;
    const legacy = (await readNamespaces())[context];
    return typeof legacy === "string" && legacy !== "" ? [legacy] : null;
  },
  async setLastScope(context: string, scope: NamespaceScope): Promise<void> {
    const scopes = await settings.get<unknown>("lastScope");
    const map: ScopeMap = isMap(scopes) ? (Object.fromEntries(Object.entries(scopes).filter(([, v]) => isScope(v))) as ScopeMap) : {};
    await settings.set("lastScope", { ...map, [context]: scope });
  },
```

Remove `getLastNamespace` / `setLastNamespace` (keep `readNamespaces` for the migration). Their callers move in Task 11 — to keep this commit green, leave both methods in place until Task 11 and delete them there.

- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/shared
git commit -m "$(cat <<'EOF'
Add namespace scopes to the frontend IPC types, settings and helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 11: The store follows a scope

**Files:**
- Modify: `src/app/store.ts`, `src/app/startup.ts`, `src/app/wireEvents.ts`, `src/features/graph/Canvas.tsx`, `src/features/graph/ViewHeader.tsx`, `src/features/table/TableView.tsx`, `src/features/editor/CreateDialog.tsx` (only the `namespace` read), `src/shared/settings.ts` (remove the legacy methods), tests: `src/app/store.test.ts`, `store.actions.test.ts`, `startup.test.ts`, `wireEvents.test.ts`, `src/features/cluster/cluster.test.tsx` (mocks)

- [ ] **Step 1: Failing tests** — in `store.test.ts` add:

```ts
  it("selectScope watches several namespaces and remembers them", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: ["a", "b"] } });
    await useAppStore.getState().selectScope(["a", "b"]);
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: ["a", "b"], expandedGroups: [] });
    expect(useAppStore.getState().connection.scope).toEqual(["a", "b"]);
    expect(settings.setLastScope).toHaveBeenCalledWith("prod", ["a", "b"]);
  });

  it("selectScope('all') sends null", async () => {
    await useAppStore.getState().selectScope("all");
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: null, expandedGroups: [] });
  });

  it("a snapshot with nodes outside the scope is ignored", () => {
    useAppStore.setState({ connection: { ...initialState().connection, scope: ["a", "b"] } });
    useAppStore.getState().applySnapshot({ nodes: [node("Pod/c/x", "Pod", "c")], edges: [] });
    expect(useAppStore.getState().graphReady).toBe(false);
    useAppStore.getState().applySnapshot({ nodes: [node("Pod/a/x", "Pod", "a"), node("Pod/b/y", "Pod", "b")], edges: [] });
    expect(useAppStore.getState().nodes.size).toBe(2);
  });

  it("a too-large snapshot keeps the counts and switches to a table", () => {
    useAppStore.setState({ connection: { ...initialState().connection, scope: "all" }, view: { name: "graph" }, lastTableKind: null });
    useAppStore.getState().applySnapshot({ nodes: [], edges: [], tooLarge: { nodes: 1873, kinds: [{ kind: "Pod", count: 1500, worst: "err" }] } });
    const s = useAppStore.getState();
    expect(s.tooLarge?.nodes).toBe(1873);
    expect(s.view).toEqual({ name: "table", kind: "Deployment" });
  });
```

(`node(id, kind, ns)` = a minimal `GraphNode` builder; reuse the file's existing one if it has it.) Run `pnpm test -- src/app` → FAIL.

- [ ] **Step 2: Store**
  - `Connection.namespace: string | null` → `scope: NamespaceScope | null` (initial `null`; `connect` sets `scope: null`).
  - `AppState` adds `tooLarge: TooLarge | null` (initial `null`, reset wherever `nodes` is reset: `selectScope`, `connect`, `disconnectedState`) and `partialKinds: Set<Kind>` (initial empty, reset in `selectScope`).
  - `DiscardDialog.pendingNamespace: string | null` → `pendingScope: NamespaceScope | null`; `confirmDiscard` calls `selectScope(discardDialog.pendingScope)`.
  - `selectNamespace: (ns) => Promise<void>` stays as `selectNamespace: (namespace) => get().selectScope([namespace])`; add `selectScope: (scope: NamespaceScope) => Promise<void>` with the old `selectNamespace` body, changed:

```ts
  selectScope: async (scope) => {
    const editor = get().details?.editor;
    if (editor && isDirty(editor)) {
      set({ discardDialog: { open: true, pendingSelect: null, pendingDeselect: false, pendingScope: scope } });
      return;
    }
    cancelTableRefresh();
    cancelDetailsRefresh();
    void get().stopLogs();
    const { expandedGroups, connection } = get();
    const expanded = [...expandedGroups];
    if (connection.context) void settings.setLastScope(connection.context, scope);
    set((s) => ({
      nodes: new Map(), edges: new Map(), graphReady: false, tooLarge: null, selectedId: null, details: null, hoveredId: null,
      deniedKinds: new Set(), partialKinds: new Set(), tables: new Map(), focusRequest: null, connection: { ...s.connection, scope },
      deleteDialog: initialState().deleteDialog, discardDialog: initialState().discardDialog, detailsMaximized: false,
      actionsMenu: null, actionDialog: null, requestedTab: null,
    }));
    try {
      await commands.selectNamespaces(scope, expanded);
      const [denied, partial] = await Promise.all([commands.deniedKinds(), commands.partialKinds()]);
      // Only if this is still the current selection — a newer one owns these sets now.
      if (get().connection.scope === scope) set({ deniedKinds: new Set(denied), partialKinds: new Set(partial) });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },
```

  - `applySnapshot` action:

```ts
  applySnapshot: (g) => {
    const before = get();
    set((s) => {
      // Belt and braces: a snapshot of the previous selection can still be queued behind
      // select_namespaces; nodes outside the current scope tell it apart.
      const scope = s.connection.scope;
      if (g.nodes.some((n) => n.namespace !== null && !inScope(scope, n.namespace))) return s;
      return { ...applySnapshot(s, g), tooLarge: g.tooLarge ?? null };
    });
    refreshDetailsIfTouched(before, get());
    const s = get();
    if (s.tooLarge && s.view.name === "graph") set({ view: { name: "table", kind: s.lastTableKind ?? "Deployment" } });
  },
```

  (the `graph_snapshot` handler in `wireEvents.ts` already refetches the table when the view is a table — it runs after `applySnapshot`, so the switched-to table is fetched.)
  - `refreshTable`: `const scope = get().connection.scope;` … `if (scope === null || get().connection.scope !== scope) return;`.
  - `reconnect`: `const { context, scope } = get().connection; … if (ok && scope) await get().selectScope(scope);`.
  - Create: `CreateDialog` state gains `namespace: string` (initial `""`); `openCreate` computes `const ns = firstNamespace(s.connection.scope, s.connection.namespaces) ?? "default";` and stores `namespace: ns, buffer: template(kind, ns)`; `setCreateKind` uses `d.namespace` for both template calls; `submitCreate` sends `commands.createObject(d.namespace, d.buffer)`. Add `setCreateNamespace: (namespace: string) => void` re-templating when untouched:

```ts
  setCreateNamespace: (namespace) =>
    set((s) => {
      const d = s.createDialog;
      const untouched = d.buffer === "" || d.buffer === template(d.kind, d.namespace);
      return { createDialog: { ...d, namespace, buffer: untouched ? template(d.kind, namespace) : d.buffer } };
    }),
```

  (add it to the action-key union around line 274.)
  - `wireEvents.ts` `connection_error`: also refresh `partialKinds`:

```ts
        void Promise.all([commands.deniedKinds(), commands.partialKinds()])
          .then(([denied, partial]) => useAppStore.setState({ deniedKinds: new Set(denied), partialKinds: new Set(partial) }))
          .catch(() => {});
```

  - `startup.ts`:

```ts
  const remembered = await settings.getLastScope(ctx.name);
  const { namespaces } = s().connection;
  const known = (ns: string) => namespaces.length === 0 || namespaces.includes(ns);
  let scope: NamespaceScope | null = null;
  if (remembered === "all") scope = namespaces.length > 0 ? "all" : null;
  else if (remembered) {
    const kept = remembered.filter(known);
    scope = kept.length > 0 ? kept : null;
  }
  if (!scope && ctx.namespace) scope = [ctx.namespace];
  if (scope) await s().selectScope(scope);
```

  - `settings.ts`: delete `getLastNamespace` / `setLastNamespace`.
  - Components reading `connection.namespace`:
    - `Canvas.tsx`: select `scope: s.connection.scope, namespaces: s.connection.namespaces`; overlay `else if (!s.scope) overlay = "Select a namespace to see its graph."; else if (!s.graphReady) overlay = \`Loading ${scopeLabel(s.scope, s.namespaces)}…\`;` … `else if (s.nodes.size === 0) overlay = isMulti(s.scope) ? "These namespaces are empty." : "Namespace is empty.";`; the refit effect depends on `s.scope` instead of `s.namespace`.
    - `ViewHeader.tsx`: `const label = scopeLabel(scope, namespaces);` and ``const caption = `${label ? `${label} · ` : ""}${count} …` ``.
    - `TableView.tsx`: `else if (!scope) message = "Select a namespace to see its resources.";` … ``else if (table.rows.length === 0) message = `No ${plural} in ${scopeLabel(scope, namespaces)}`;``.
    - `CreateDialog.tsx`: replace the `namespace` selector read with `dialog.namespace` (the select comes in Task 15); keep ``{dialog.namespace && <span className="text-xs text-text-muted">in {dialog.namespace}</span>}`` for now.
- [ ] **Step 3: Existing tests, mechanically**
  - Settings mocks (`store.test.ts`, `store.actions.test.ts`, `startup.test.ts`, `cluster.test.tsx`): replace `getLastNamespace` / `setLastNamespace` by `getLastScope` / `setLastScope` (startup's in-memory mock stores the scope value).
  - `invoke` expectations `("select_namespace", { namespace: "x", expandedGroups: … })` → `("select_namespaces", { namespaces: ["x"], expandedGroups: … })`; `not.toHaveBeenCalledWith("select_namespace", …)` → `"select_namespaces"`.
  - `connection.namespace` assertions → `connection.scope` with `toEqual(["x"])`; `connection: { …, namespace: "p" }` fixtures → `scope: ["p"]`.
  - `pendingNamespace: null` → `pendingScope: null`; `pendingNamespace: "q"` → `pendingScope: ["q"]`.
  - `settings.setLastNamespace` called with `("prod", "q")` → `settings.setLastScope` with `("prod", ["q"])`.
  - Any test that mocks `invoke` for `denied_kinds` must also answer `partial_kinds` with `[]`.
  - `startup.test.ts` "remembered namespace" cases: store `["payments"]` under the new key; add one where only the legacy key exists.
- [ ] **Step 4: Run** — `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "$(cat <<'EOF'
Keep a namespace scope in the store and select it with select_namespaces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 12: The multi-select namespace picker

**Files:**
- Modify: `src/features/cluster/NamespacePicker.tsx`, `src/features/cluster/Header.tsx`, `src/features/cluster/cluster.test.tsx`

Interaction: clicking a namespace's **name** selects only it (and closes); ticking checkboxes stages a set applied with **Apply (n)**; **All namespaces** applies `"all"`. Escape closes the popover without reaching the app's global Escape handler.

- [ ] **Step 1: Failing tests** — replace the two `NamespacePicker` tests in `cluster.test.tsx`:

```tsx
describe("NamespacePicker", () => {
  const open = (selectScope = vi.fn(async () => {})) => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: ["blog", "payments", "shop"], scope: ["shop"] }, selectScope });
    render(<NamespacePicker />);
    fireEvent.click(screen.getByRole("button", { name: "Namespace" }));
    return selectScope;
  };

  it("shows the scope and picks one namespace by name", () => {
    const selectScope = open();
    fireEvent.click(screen.getByRole("button", { name: "payments" }));
    expect(selectScope).toHaveBeenCalledWith(["payments"]);
    expect(screen.queryByRole("dialog", { name: "Namespaces" })).toBeNull();
  });

  it("applies several ticked namespaces", () => {
    const selectScope = open();
    fireEvent.click(screen.getByLabelText("Include blog"));
    fireEvent.click(screen.getByRole("button", { name: "Apply (2)" }));
    expect(selectScope).toHaveBeenCalledWith(["blog", "shop"]);
  });

  it("selects all namespaces", () => {
    const selectScope = open();
    fireEvent.click(screen.getByRole("button", { name: /All namespaces \(3\)/ }));
    expect(selectScope).toHaveBeenCalledWith("all");
  });

  it("filters the list", () => {
    open();
    fireEvent.change(screen.getByLabelText("Filter namespaces"), { target: { value: "pay" } });
    expect(screen.queryByRole("button", { name: "blog" })).toBeNull();
    expect(screen.getByRole("button", { name: "payments" })).toBeTruthy();
  });

  it("Escape closes it without reaching the global handler", () => {
    open();
    const global = vi.fn();
    window.addEventListener("keydown", (e) => { if (!e.defaultPrevented) global(); });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Namespaces" })).toBeNull();
    expect(global).not.toHaveBeenCalled();
  });

  it("falls back to a text input when the namespace list is empty", () => {
    const selectScope = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: [] }, selectScope });
    render(<NamespacePicker />);
    const input = screen.getByLabelText("Namespace");
    fireEvent.change(input, { target: { value: "team-a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selectScope).toHaveBeenCalledWith(["team-a"]);
  });
});
```

and in the Header test "+ Create … disabled until a namespace is selected" set `scope` instead of `namespace`. Run → FAIL.

- [ ] **Step 2: Implement** — `NamespacePicker.tsx`:

```tsx
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { NamespaceScope } from "../../shared/ipc/types";
import { scopeLabel } from "../../shared/scope";
import { Button } from "../../shared/ui/Button";

const FIELD = "no-drag h-9 rounded-xl border border-border-strong bg-transparent px-3 text-sm font-medium text-text-hi outline-none focus:border-accent";
const ROW = "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm text-text-hi hover:bg-surface";

/** One namespace (click its name), several (tick them, then Apply) or all of them. */
export function NamespacePicker() {
  const { namespaces, scope, selectScope } = useAppStore(
    useShallow((s) => ({ namespaces: s.connection.namespaces, scope: s.connection.scope, selectScope: s.selectScope })),
  );
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Escape is ours while open: capture it before the app's global handler, which skips handled events.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const apply = (next: NamespaceScope) => {
    setOpen(false);
    void selectScope(next);
  };

  if (namespaces.length === 0) {
    return (
      <input aria-label="Namespace" className={FIELD} placeholder="namespace…" value={draft}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) apply([draft.trim()]); }} />
    );
  }

  const toggleOpen = () => {
    if (!open) {
      setTicked(new Set(scope === null || scope === "all" ? [] : scope));
      setFilter("");
    }
    setOpen(!open);
  };
  const toggle = (ns: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    return next;
  });
  const q = filter.trim().toLowerCase();
  const shown = namespaces.filter((ns) => ns.toLowerCase().includes(q));

  return (
    <div ref={root} className="no-drag relative">
      <button type="button" aria-label="Namespace" aria-haspopup="dialog" aria-expanded={open} className={`${FIELD} flex items-center gap-2`} onClick={toggleOpen}>
        <span className="max-w-56 truncate">{scopeLabel(scope, namespaces) ?? "namespace…"}</span>
        <ChevronDown className="size-4 text-text-muted" />
      </button>
      {open && (
        <div role="dialog" aria-label="Namespaces" className="absolute left-0 top-11 z-30 w-72 rounded-card border border-border bg-elevated p-2">
          <input autoFocus aria-label="Filter namespaces" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)}
            className="mb-2 h-8 w-full rounded-lg border border-border-strong bg-surface px-2 text-sm text-text-hi outline-none focus:border-accent" />
          <button type="button" className={`${ROW} w-full`} onClick={() => apply("all")}>
            <span className="w-4">{scope === "all" && <Check className="size-4 text-accent" />}</span>
            All namespaces ({namespaces.length})
          </button>
          <ul className="max-h-72 overflow-auto">
            {shown.map((ns) => (
              <li key={ns} className="flex items-center gap-1 pl-2">
                <input type="checkbox" aria-label={`Include ${ns}`} checked={ticked.has(ns)} onChange={() => toggle(ns)} />
                <button type="button" className={ROW} onClick={() => apply([ns])}>{ns}</button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-2 py-1.5 text-xs text-text-muted">No match.</li>}
          </ul>
          <div className="mt-2 flex justify-end">
            <Button variant="primary" disabled={ticked.size === 0} onClick={() => apply([...ticked].sort())}>
              {ticked.size > 0 ? `Apply (${ticked.size})` : "Apply"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

`Header.tsx`: Create `disabled={connection.scope === null}`, title `connection.scope === null ? "Select a namespace first" : "Create an object"`.

- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 4: Commit**

```bash
git add src/features/cluster
git commit -m "$(cat <<'EOF'
Pick one, several or all namespaces in the header

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 13: Lanes in the graph

**Files:**
- Create: `src/features/graph/LaneNode.tsx`
- Modify: `src/features/graph/toFlow.ts`, `src/features/graph/Canvas.tsx`, `src/features/graph/toFlow.test.ts`, `src/features/graph/Canvas.test.tsx`

With nodes from more than one namespace, each namespace is laid out on its own (the existing `layout()`), lanes are stacked vertically in name order (cluster-scoped objects in a last "Cluster-scoped" lane), and a non-interactive lane frame is drawn behind each. Cross-lane edges get no waypoints. One namespace: output unchanged.

- [ ] **Step 1: Failing tests** — `toFlow.test.ts`:

```ts
  it("lays several namespaces out in lanes", () => {
    const n = (id: string, kind: Kind, ns: string | null): GraphNode => ({ id, kind, namespace: ns, name: id.split("/").pop()!, status: "ok", badges: [], group: null });
    const nodes = new Map([
      ["Deployment/a/web", n("Deployment/a/web", "Deployment", "a")],
      ["Pod/a/web-1", n("Pod/a/web-1", "Pod", "a")],
      ["Deployment/b/api", n("Deployment/b/api", "Deployment", "b")],
      ["PersistentVolumeClaim/b/data", n("PersistentVolumeClaim/b/data", "PersistentVolumeClaim", "b")],
      ["PersistentVolume//pv", n("PersistentVolume//pv", "PersistentVolume", null)],
    ].map(([k, v]) => [k as string, v as GraphNode]));
    const edges = new Map([
      ["owns", { id: "owns", source: "Deployment/a/web", target: "Pod/a/web-1", relation: "owns" as const }],
      ["binds", { id: "binds", source: "PersistentVolume//pv", target: "PersistentVolumeClaim/b/data", relation: "binds" as const }],
    ]);
    const flow = toFlow({ ...baseInput, nodes, edges });
    const lanes = flow.nodes.filter((x) => x.type === "lane");
    expect(lanes.map((l) => l.data.label)).toEqual(["a", "b", "Cluster-scoped"]);
    expect(lanes.map((l) => l.data.count)).toEqual([2, 2, 1]);
    const inLane = (id: string, laneId: string) => {
      const node = flow.nodes.find((x) => x.id === id)!;
      const lane = flow.nodes.find((x) => x.id === laneId)!;
      return node.position.y >= lane.position.y && node.position.y + NODE_HEIGHT <= lane.position.y + lane.height!;
    };
    expect(inLane("Pod/a/web-1", "lane:a")).toBe(true);
    expect(inLane("Deployment/b/api", "lane:b")).toBe(true);
    expect(inLane("PersistentVolume//pv", "lane:")).toBe(true);
    expect(flow.edges.find((e) => e.id === "binds")!.data.waypoints).toBeUndefined();
  });

  it("draws no lanes for one namespace", () => {
    const flow = toFlow({ ...baseInput });  // the file's existing single-namespace input
    expect(flow.nodes.some((x) => x.type === "lane")).toBe(false);
  });
```

(`baseInput` = whatever default `ToFlowInput` the file already builds; add one if it has none.) Run → FAIL.

- [ ] **Step 2: Implement** — in `toFlow.ts`:

```ts
/** Space for a lane's title above its first row, and the padding around its nodes. */
export const LANE_HEADER = 40;
export const LANE_PAD = 24;
export const LANE_GAP = 48;

export interface LaneNodeData extends Record<string, unknown> { label: string; count: number }
export type LaneFlowNode = Node<LaneNodeData, "lane">;
export type FlowNode = ResourceFlowNode | LaneFlowNode;

/** Per-namespace layouts stacked into lanes; `null` when the nodes span one namespace or none. */
function laneLayout(nodes: GraphNode[], edges: GraphEdge[]): (Layout & { lanes: LaneFlowNode[] }) | null {
  const keys = new Set(nodes.map((n) => n.namespace ?? ""));
  const named = [...keys].filter((k) => k !== "").sort((a, b) => a.localeCompare(b));
  if (named.length <= 1) return null;
  const order = keys.has("") ? [...named, ""] : named;
  const positions = new Map<NodeId, Position>();
  const waypoints = new Map<string, Position[]>();
  const lanes: LaneFlowNode[] = [];
  let top = 0;
  for (const key of order) {
    const members = nodes.filter((n) => (n.namespace ?? "") === key);
    const ids = new Set(members.map((n) => n.id));
    const inner = layout(members, edges.filter((e) => ids.has(e.source) && ids.has(e.target)));
    const shift = (p: Position): Position => ({ x: p.x + LANE_PAD, y: p.y + top + LANE_HEADER });
    let right = 0, bottom = 0;
    for (const [id, p] of inner.positions) {
      positions.set(id, shift(p));
      right = Math.max(right, p.x + NODE_WIDTH);
      bottom = Math.max(bottom, p.y + NODE_HEIGHT);
    }
    for (const [edgeId, points] of inner.waypoints) waypoints.set(edgeId, points.map(shift));
    const height = LANE_HEADER + bottom + LANE_PAD;
    lanes.push({
      id: `lane:${key}`, type: "lane", position: { x: 0, y: top }, width: right + 2 * LANE_PAD, height,
      draggable: false, selectable: false, focusable: false, zIndex: -1,
      data: { label: key === "" ? "Cluster-scoped" : key, count: members.length },
    });
    top += height + LANE_GAP;
  }
  return { positions, waypoints, lanes };
}
```

(import `type Layout` from `./layout`.) In `toFlow`:

```ts
  const laned = laneLayout(visible, visibleEdges);
  const { positions, waypoints } = laned ?? layout(visible, visibleEdges);
```

and return `{ nodes: [...(laned?.lanes ?? []), ...nodes], edges }` with the return type `{ nodes: FlowNode[]; edges: RelationFlowEdge[] }`. Lane ids start with `lane:`, which no node id (`Kind/…`) can.

`LaneNode.tsx`:

```tsx
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import type { LaneFlowNode } from "./toFlow";

/** A namespace's frame in a multi-namespace graph. Never interactive: clicks reach the pane and edges. */
export const LaneNode = memo(function LaneNode({ data, width, height }: NodeProps<LaneFlowNode>) {
  return (
    <div className="pointer-events-none rounded-card border border-border/70" style={{ width, height }}>
      <div className="flex h-10 items-baseline gap-2 px-6 pt-3">
        <span className="text-sm font-medium text-text-hi">{data.label}</span>
        <span className="text-xs text-text-muted">{data.count} {data.count === 1 ? "object" : "objects"}</span>
      </div>
    </div>
  );
});
```

`Canvas.tsx`: `const nodeTypes = { resource: ResourceNode, lane: LaneNode };`; the node handlers take `NodeMouseHandler<FlowNode>` and start with `if (node.type !== "resource") return;` (the double-click handler then reads `node.data.node.kind`); `onNodeMouseEnter` likewise. The MiniMap keeps `nodeColor="#3a3340"` — add `nodeStrokeColor`/`nodeColor` as a function returning `"transparent"` for `type === "lane"` so lanes don't paint solid blocks: `nodeColor={(n) => (n.type === "lane" ? "transparent" : "#3a3340")}`.

Canvas test: render with two namespaces' nodes, assert two `lane:` frames exist (by their label text) and clicking a resource node still selects it.

- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 4: Commit**

```bash
git add src/features/graph
git commit -m "$(cat <<'EOF'
Lay several namespaces out in lanes on the graph

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 14: Navigator and tables across namespaces

**Files:**
- Modify: `src/features/navigator/ResourceTree.tsx`, `src/features/navigator/Navigator.test.tsx`, `src/features/graph/ViewHeader.tsx`, `src/features/graph/ViewHeader.test.tsx`, `src/features/table/TableView.test.tsx`

- [ ] **Step 1: Failing tests**
  - Navigator: with `tooLarge: { nodes: 1873, kinds: [{ kind: "Pod", count: 1500, worst: "err" }] }` and no nodes, the Pods row shows `1500`; with `partialKinds: new Set(["Secret"])` the Secrets row shows `partial` with title "Some namespaces are not readable (RBAC)".
  - ViewHeader: with `tooLarge.nodes = 1873`, the graph caption ends `1873 objects`.
  - TableView: a table whose first column is `{ key: "namespace", label: "Namespace" }` renders a `Namespace` header first and the search box filters on it.
  Run → FAIL (the TableView test may already pass — it guards the generic rendering).
- [ ] **Step 2: Implement**
  - `ResourceTree.tsx`: read `tooLarge` and `partialKinds`; `const stats = useMemo(() => tooLarge ? new Map(tooLarge.kinds.map((k) => [k.kind, { count: k.count, worst: k.worst }])) : kindStats(nodes), [nodes, tooLarge]);`; the kind row gets `partial: boolean` and renders, before the count, `{partial && <span className="text-[11px] italic text-text-muted" title="Some namespaces are not readable (RBAC)">partial</span>}`.
  - `ViewHeader.tsx`: graph count `count = tooLarge ? tooLarge.nodes : sum of stats` (keep the stats sum otherwise).
- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 4: Commit**

```bash
git add src/features/navigator src/features/graph/ViewHeader.tsx src/features/graph/ViewHeader.test.tsx src/features/table/TableView.test.tsx
git commit -m "$(cat <<'EOF'
Count across namespaces in the navigator and mark partially readable kinds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 15: A namespace select in **+ Create**

**Files:**
- Modify: `src/features/editor/CreateDialog.tsx`, `src/features/editor/CreateDialog.test.tsx`

- [ ] **Step 1: Failing test** — with `connection: { namespaces: ["a", "b"], scope: ["b", "a"] }`, `openCreate("ConfigMap")` shows a `Namespace` select set to `b` and the template contains `namespace: b`; choosing `a` re-templates to `namespace: a`; `Create` invokes `create_object` with `{ namespace: "a", yaml: … }`. With `namespaces: []` the field is a text input. Run → FAIL.
- [ ] **Step 2: Implement** — in `CreateDialog.tsx` read `namespaces: s.connection.namespaces` and `setCreateNamespace`; replace the "in {namespace}" span with:

```tsx
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Namespace
            {namespaces.length > 0 ? (
              <select aria-label="Namespace" value={dialog.namespace} onChange={(e) => setCreateNamespace(e.target.value)} disabled={dialog.submitting}
                className="h-9 rounded-xl border border-border-strong bg-surface px-3 text-sm text-text-hi outline-none focus:border-accent">
                {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
              </select>
            ) : (
              <input aria-label="Namespace" value={dialog.namespace} onChange={(e) => setCreateNamespace(e.target.value)} disabled={dialog.submitting}
                className="h-9 w-40 rounded-xl border border-border-strong bg-surface px-3 text-sm text-text-hi outline-none focus:border-accent" />
            )}
          </label>
```

(If the dialog's namespace is not among `namespaces` — e.g. `"default"` fallback — add it as the first option so the select can show it.)
- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 4: Commit**

```bash
git add src/features/editor
git commit -m "$(cat <<'EOF'
Choose the namespace in the Create dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 16: The too-large notice on the graph

**Files:**
- Modify: `src/features/graph/Canvas.tsx`, `src/features/graph/Canvas.test.tsx`

- [ ] **Step 1: Failing test** — with `graphReady: true`, `tooLarge: { nodes: 1873, kinds: [] }` and the graph view, the canvas shows "1,873 objects — too many for the graph. Use the tables, or pick fewer namespaces." Run → FAIL.
- [ ] **Step 2: Implement** — select `tooLarge` in `Canvas.tsx` and, before the empty check:

```ts
  else if (s.tooLarge) overlay = `${s.tooLarge.nodes.toLocaleString("en-US")} objects — too many for the graph. Use the tables, or pick fewer namespaces.`;
```

- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 4: Commit**

```bash
git add src/features/graph/Canvas.tsx src/features/graph/Canvas.test.tsx
git commit -m "$(cat <<'EOF'
Say when a selection is too large for the graph

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 17: Remove the one-namespace command

**Files:**
- Modify: `src-tauri/src/commands.rs` (and its `generate_handler!`), `src-tauri/src/session/mod.rs`, `src/shared/ipc/commands.ts`, `docs/ipc-contract.md`

- [ ] **Step 1:** `grep -rn "select_namespace\b\|selectNamespace(" src src-tauri` — only the store's `selectNamespace` convenience (used by `ContextPicker`, `startup` fallback and tests) may remain; it calls `selectScope`.
- [ ] **Step 2:** Delete the `select_namespace` Tauri command and its registration, `Session::select_namespace`, `commands.selectNamespace` in `commands.ts`, and the `select_namespace` row in `docs/ipc-contract.md` (the ordering rule now says `select_namespaces`).
- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test && cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check` → PASS.
- [ ] **Step 4: Commit**

```bash
git add src-tauri/src src/shared/ipc/commands.ts docs/ipc-contract.md
git commit -m "$(cat <<'EOF'
Drop the one-namespace select_namespace command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 18: README and full checks

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document** — in the **Navigator.** paragraph (or right after it) add:

```markdown
**Several namespaces.** The namespace picker in the header takes one namespace (click its name), several (tick them, then **Apply**) or **All namespaces**. With more than one, the graph shows a lane per namespace, tables get a Namespace column, and the navigator counts across all of them. Objects keep their own namespace for details, editing, logs, the terminal and actions; **+ Create** asks for the namespace. A selection with more than 1 500 objects is shown as tables only. With *All namespaces*, a kind your role cannot list cluster-wide is watched per namespace and marked *partial*.
```

- [ ] **Step 2: Every check CI runs, plus build and smoke**

```bash
rtk proxy pnpm typecheck
rtk proxy pnpm test
rtk proxy pnpm build
cd src-tauri
rtk proxy cargo fmt --check
rtk proxy cargo clippy --all-targets -- -D warnings
rtk proxy cargo test
WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored --nocapture 2>&1 | tee /tmp/claude-smoke-final.log
```

Expected: all green (smoke `1 passed`). The smoke only with the local `docker-desktop` context.

- [ ] **Step 3: Live check** (maintainer) — in `pnpm tauri dev`: pick `shop` + `blog` → two lanes, a Namespace column in Deployments; pick All → `kube-system` lane; switch back to `shop` → no lanes, no Namespace column; Create from All defaults to the first namespace.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Document watching several namespaces in the README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

## Self-review

- **Spec coverage:** picker (12), lanes (13), large graphs (6, 11, 16), tables/navigator (7, 14), per-object features unchanged (table above), Create namespace (11, 15), RBAC fallback + partial (2, 3, 5, 14), metrics (4), settings per context (10, 11), contract (8), smoke (9), old command removed (17), README (18).
- **Placeholders:** none; mechanical test edits are listed explicitly in Tasks 2, 4 and 11.
- **Types:** `NamespaceScope` (Rust enum / TS `"all" | string[]`), `StreamId`, `StoreEvent::{Restarted,InitDone,Recovered}(StreamId)`, `Failed { stream, … }`, `FellBack { kind, namespaces }`, `TooLarge { nodes, kinds: KindStat[] }`, `Graph.too_large` ↔ `tooLarge`, commands `select_namespaces { namespaces, expandedGroups }` / `partial_kinds`, store `selectScope` / `connection.scope` / `pendingScope` / `tooLarge` / `partialKinds` / `setCreateNamespace` are used consistently across tasks.

---

## Deviations from the spec

1. **No lane metadata from the backend.** Nodes already carry `namespace`; the frontend groups by it. The backend only adds the too-large guard.
2. **`denied_kinds` is unchanged; partial kinds come from a new `partial_kinds` command** instead of being mixed into `denied_kinds`, so the existing contract and its callers keep their meaning.
3. **The 1 500 limit counts all nodes the backend builds** (pod groups count as one node), not "visible" nodes — the backend does not know which kinds the frontend hides.
4. **With a too-large graph, Overview's Related list is empty and pod-group details are unavailable** (they come from the graph, which is not kept); tables, YAML, events, logs, terminal and actions still work.
5. **Metrics for a set of namespaces are listed one namespace at a time per tick, and the first failure answers for the tick** (a 403 in one namespace hides metrics for the whole selection). Rare; kept simple.
6. **The too-large message uses `1,873`** (en-US grouping) rather than a thin-space `1 873`.
7. **Picking a namespace by name applies at once; several are ticked and applied with Apply**, so a multi-select doesn't restart every watcher on each tick.
8. **The settings key is `lastScope`; `lastNamespace` is only read for migration.**

## Uncertainties

- Lane frames use `zIndex: -1` and `pointer-events: none`; whether React Flow 12 paints them under the edges or over them (transparent, so edges stay visible either way) needs a look in the live app.
- Whether the API server returns 403 as `InitialListFailed` (handled) or `WatchStartFailed` for a cluster-wide list without RBAC — both classify as Forbidden, so the fallback triggers either way, but only the smoke on a restricted context (not part of this plan) would prove it.
