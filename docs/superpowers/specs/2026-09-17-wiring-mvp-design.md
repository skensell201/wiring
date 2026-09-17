# Wiring — MVP Design

**Date:** 2026-09-17
**Status:** approved
**Scope:** first shippable version (0.1.0) — a desktop Kubernetes IDE whose centerpiece is a live graph of resource relationships.

## 1. Goal

Wiring is a Lens-like desktop application for Kubernetes. Unlike Lens, its primary view is not a resource table but a **live, hierarchical graph** of how objects in a namespace are wired together: Ingress → Service → Deployment → ReplicaSet → Pod, plus ConfigMaps, Secrets, PVCs, ServiceAccounts and HPAs feeding into workloads.

The MVP answers one question well: *"What is connected to what in this namespace, and what is unhealthy right now?"*

Targets: **macOS and Windows** from the first release. Development happens on macOS; Windows builds come from CI.

Visual style: the n8n design system (dark, violet-black surfaces, ember-gradient primary buttons, blue→violet gradient connections). Dark theme only.

## 2. Non-goals (deferred to later specs)

Pod logs, exec/shell, port-forward, YAML editing, metrics, "all namespaces" view with namespace grouping, multiple clusters open at once, NetworkPolicy / RBAC / CRD relationships, Helm, code signing, auto-update, light theme.

## 3. Technology

| Layer | Choice |
|---|---|
| Shell | Tauri 2 |
| Backend | Rust (stable), `kube` + `kube-runtime`, `tokio`, `serde`, `tracing`, `tauri-plugin-store` |
| Frontend | React 19, TypeScript, Vite, `@xyflow/react` (React Flow), `elkjs` in a web worker, `zustand`, Tailwind CSS, `shiki` for YAML highlighting |
| Package manager | pnpm; Node 22 |
| Tests | Rust `cargo test`; Vitest for the frontend; `kind`-based smoke test in CI |
| CI | GitHub Actions, `tauri-action`, matrix `macos-latest` (universal .dmg) + `windows-latest` (.msi via WiX, .exe via NSIS) |

Repository layout (monorepo):

```
wiring/
  src/            React frontend
  src-tauri/      Rust backend + Tauri config
  docs/           specs and plans
  .github/        CI workflows
```

## 4. Architecture

```
┌──────────────── Tauri 2 window ─────────────────────────┐
│  Frontend (React)                                       │
│  ├─ features/cluster   context + namespace selection    │
│  ├─ features/graph     canvas, node cards, ELK layout   │
│  ├─ features/details   bottom panel: Overview/YAML/Events│
│  ├─ shared/ipc         typed invoke()/listen() wrappers │
│  └─ shared/theme       design tokens                    │
│         ▲  Tauri commands (request/response)            │
│         ▼  Tauri events (push)                          │
│  Backend (Rust)                                         │
│  ├─ kubeconfig   read contexts from kubeconfig files    │
│  ├─ session      one active connection + watchers       │
│  ├─ store        in-memory cache of objects             │
│  ├─ graph        pure: store → Graph, diff → GraphDelta │
│  └─ commands     thin Tauri command/event layer         │
└─────────────────────────────────────────────────────────┘
```

### 4.1 Key decision: the graph is built in Rust

The backend caches every watched object for the selected namespace, recomputes relationships on every change, and pushes a compact **delta** to the frontend. The frontend never sees raw Kubernetes objects except when it explicitly asks for one (`get_object`). Consequences:

- `graph` is pure, synchronous code, unit-tested against YAML fixtures without a cluster.
- The frontend is a renderer: it lays out and draws `{nodes, edges}` and knows nothing about selectors or owner references.
- New relationship types (NetworkPolicy, RBAC) are backend-only changes.

### 4.2 Backend modules

**`kubeconfig`** — Reads `~/.kube/config`, every path in `KUBECONFIG` (`:` on macOS, `;` on Windows), and any user-added file (persisted in settings). Returns `Vec<ContextInfo { name, cluster, user, namespace?, source_file }>`. Depends only on `kube::config`. Exec-based auth plugins (aws, gcloud, az, oidc) are handled by `kube` itself.

**`session`** — Owns exactly one active connection. `connect(context)` builds a `kube::Client`, calls `/version`, lists namespaces. `select_namespace(ns)` drops any previous watcher set and starts one `kube_runtime::watcher` + reflector per watched kind, scoped to the namespace (PersistentVolume is cluster-scoped and watched cluster-wide). After every stream has emitted `InitDone`, it builds the first graph and emits `graph_snapshot`. Subsequent events are debounced (150 ms) and turned into `graph_delta`. Changing context or namespace tears the session down and rebuilds it.

Watched kinds (15): Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, Pod, Service, Ingress, ConfigMap, Secret, PersistentVolumeClaim, PersistentVolume, ServiceAccount, HorizontalPodAutoscaler. Events are watched separately, per selected object (see 6.4).

**`store`** — `HashMap<ObjectKey, Object>` where `Object` is a typed enum over the 15 watched k8s-openapi structs and `ObjectKey = (kind, namespace, name)` (namespace is normalized to `None` for cluster-scoped kinds). Plain data, no async.

**`graph`** — `fn build(store: &Store, opts: &BuildOptions) -> Graph` and `fn diff(old: &Graph, new: &Graph) -> GraphDelta`. `BuildOptions { expanded_groups: HashSet<NodeId> }`. Pure functions; the bulk of the test suite lives here.

**`commands`** — Tauri commands and event emission. No logic beyond argument validation and calling into `session`.

### 4.3 IPC contract

Commands (frontend → backend):

| Command | Args | Returns |
|---|---|---|
| `list_contexts` | — | `ContextInfo[]` |
| `add_kubeconfig` | `path` | `ContextInfo[]` (refreshed list) |
| `connect` | `context` | `{ serverVersion, namespaces[] }` |
| `disconnect` | — | `()` — tears down the active session |
| `select_namespace` | `namespace, expandedGroups[]` | `()` — graph arrives via event |
| `set_expanded_groups` | `expandedGroups[]` | `()` — rebuild + delta via event |
| `get_object` | `nodeId` | `{ yaml, summary: [string, string][] (ordered key/value rows), related: NodeId[] }` |
| `watch_events` | `nodeId \| null` | `()` — starts/stops the per-object Events watcher |
| `denied_kinds` | — | `Kind[]` — kinds the active session was denied (RBAC) access to |

`ConnectInfo.namespaces` may come back empty when the context has no cluster-wide `list namespaces` permission and no default namespace either (403 on the namespace list falls back to the context's own namespace, spec §8).

Events (backend → frontend):

| Event | Payload |
|---|---|
| `graph_snapshot` | `Graph` (full replace) |
| `graph_delta` | `GraphDelta` |
| `object_events` | `{ nodeId, events: K8sEvent[] }` (full list for the selected object) |
| `connection_state` | `"connected" \| "degraded" \| "disconnected"` |
| `connection_error` | `AppError` |

All payloads are `serde`-serialized; TypeScript types are hand-written mirrors in `shared/ipc/types.ts` and checked by a Rust test that serializes a sample of each type and compares against a committed JSON fixture.

## 5. Graph model

### 5.1 Node

```
Node {
  id: "<Kind>/<namespace>/<name>"      // cluster-scoped: "<Kind>//<name>"
  kind: Kind
  namespace: string | null
  name: string
  status: "ok" | "warn" | "err" | "unknown"
  badges: string[]                     // 0–2 short strings
  group: { count, ok, warn, err } | null   // only for PodGroup
}
```

Badges and status per kind:

| Kind | Badges | Status rule |
|---|---|---|
| Deployment / StatefulSet / DaemonSet | `ready/desired`, first container image | err if ready < desired and condition `Progressing=False`; warn if ready < desired |
| ReplicaSet | `ready/desired` | as above. **Hidden** when it is the only active ReplicaSet of a Deployment; its edges pass through (Deployment → Pod) |
| Job | `succeeded/completions` | err if condition `Failed=True` |
| CronJob | schedule | warn if `spec.suspend` |
| Pod | phase or waiting reason (`Running`, `CrashLoopBackOff`), `↻ N` restarts if N > 0 | err: `Failed`, `CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `OOMKilled`; warn: `Pending`, `Running` but not all containers ready; warn: `Terminating` when `metadata.deletionTimestamp` is set (an err reason still wins) |
| Service | type, `port→targetPort` (first port) | warn if the selector matches zero pods |
| Ingress | first host (`+N` if more) | — |
| ConfigMap / Secret | `N keys` | — |
| PersistentVolumeClaim | requested size, StorageClass | warn if phase `Pending` |
| PersistentVolume | capacity, reclaim policy | — |
| ServiceAccount | — | — |
| HorizontalPodAutoscaler | `min–max`, `current` replicas | warn if condition `ScalingLimited=True` |
| PodGroup | `×N`, `ok/warn/err` counts | worst status in the group |

### 5.2 Edge

```
Edge { id: "<source>-><target>:<relation>", source: NodeId, target: NodeId, relation }
relation ∈ owns | selects | routes | mounts | envFrom | claims | binds | usesSA | scales
```

Direction is always left → right in the layout ("producer → consumer"):

| Relation | Source → Target | Derived from |
|---|---|---|
| `owns` | Deployment → ReplicaSet → Pod; StatefulSet/DaemonSet/Job → Pod; CronJob → Job | `metadata.ownerReferences` |
| `selects` | Service → Pod | `spec.selector` ⊆ `pod.metadata.labels` |
| `routes` | Ingress → Service | `spec.rules[].http.paths[].backend.service.name`, `spec.defaultBackend` |
| `mounts` | ConfigMap/Secret → Pod | `spec.volumes[].configMap / secret / projected.sources[]` |
| `envFrom` | ConfigMap/Secret → Pod | `containers[].envFrom[]`, `containers[].env[].valueFrom.configMapKeyRef / secretKeyRef` |
| `claims` | PVC → Pod | `spec.volumes[].persistentVolumeClaim.claimName` |
| `binds` | PV → PVC | `pvc.spec.volumeName` |
| `usesSA` | ServiceAccount → Pod | `spec.serviceAccountName` (default `default`) |
| `scales` | HPA → Deployment/StatefulSet | `spec.scaleTargetRef` |

Ingress `secretName` (TLS) → Secret is out of scope for the MVP.

### 5.3 Pod collapsing (PodGroup)

If one owner (ReplicaSet, StatefulSet, DaemonSet, Job) has **more than 5** pods, they are replaced by one `PodGroup` node with id `PodGroup/<ns>/<owner-kind>/<owner-name>`. `<owner-kind>/<owner-name>` names the *visible* owner, not necessarily the immediate one: a Deployment whose single ReplicaSet is hidden (§5.1) yields `PodGroup/<ns>/Deployment/<name>`, while a ReplicaSet still visible mid-rollout yields its own `PodGroup/<ns>/ReplicaSet/<rs>` per ReplicaSet. Edges from ConfigMap/Secret/PVC/SA to member pods are aggregated into one edge per source to the group; Service → pod edges likewise. Clicking the group adds its id to `expandedGroups`; the backend rebuilds with the pods expanded. The frontend persists `expandedGroups` for the session only, and since the group id depends on the visible owner, a rollout that changes which owner is visible (e.g. the hidden-single-RS case flipping) changes the id — expanded state does not survive that change and the group re-collapses.

### 5.4 Layout

ELK `layered` algorithm, direction `RIGHT`, run in a web worker. Layers are fixed by kind via `layerConstraint`, so the layout is stable across deltas:

```
0: HPA
1: Ingress
2: Service
3: Deployment, StatefulSet, DaemonSet, CronJob
4: ReplicaSet, Job
5: ConfigMap, Secret, PersistentVolumeClaim, PersistentVolume, ServiceAccount
6: Pod, PodGroup
```

PV sits in layer 5 alongside PVC; the `binds` edge PV → PVC is rendered as a short same-layer edge. On every delta the whole layout is recomputed; React Flow animates node position changes over 300 ms. Nodes hidden by kind filters are excluded from layout so the remaining graph tightens.

## 6. Data flow

### 6.1 Startup
1. `list_contexts()` → context picker. Last used context and namespace are stored via `tauri-plugin-store` (`settings.json`) and auto-selected if still present.
2. No kubeconfig found → empty state with instructions and an "Add kubeconfig file…" button.

### 6.2 Connect
`connect(context)` → on success the header shows cluster name and version; on failure `connection_error` is shown as a toast and the picker stays open.

### 6.3 Namespace and live graph
`select_namespace(ns)` → session starts watchers → `graph_snapshot` → thereafter `graph_delta` every ≤150 ms when something changed. The frontend applies deltas to its node/edge maps, re-runs layout, and preserves selection if the selected node still exists.

### 6.4 Details
Clicking a node → `get_object(id)` → panel shows Overview (summary key/value grid + "Related" list of node ids, click navigates), YAML (read-only, highlighted, copy button), Events. Selecting a node also calls `watch_events(id)`: the backend watches Events with `involvedObject.uid == <uid>` and pushes `object_events` on change; selecting another node or deselecting stops the previous watcher. PodGroup has no YAML; its Overview lists member pods.

### 6.5 Filters and search
Kind filter chips and name search live entirely in the frontend. Filtering hides nodes and their edges from layout; search highlights matches and dims the rest. Neither touches the backend.

### 6.6 Reconnect
`kube_runtime::watcher` reconnects with exponential backoff on its own. If any kind has been in error continuously for 30 s, the session emits `connection_state: "degraded"` (yellow dot in the header); the first transient error per kind is reported once as `connection_error`, and repeats of the same kind's outage stay silent until it recovers. 403, and 404 on the initial list, are fatal for that kind (watching stops, it is reported via `denied_kinds`), while 401 is fatal for the whole session (reported once as `connection_error` followed by `disconnected`; the user must reconnect); other errors are left to the watcher's own backoff. When every watcher is healthy again the session emits `"connected"` and a fresh `graph_snapshot`. The header's **Reconnect** button (ember gradient) tears down and rebuilds the session.

## 7. UI

Layout (chosen from three mockups; see `.superpowers/brainstorm/` for the originals):

```
┌────────────────────────────────────────────────────────┐
│ ◉ Wiring   ⎈ prod-eu ▾   ns: payments ▾   🔍 ⌘K   ● Reconnect │  48 px header
├────────────────────────────────────────────────────────┤
│ [Ingress][Service][Deploy][Pod][ConfigMap][Secret]…    │  kind chips (top-left of canvas)
│                                                        │
│                    graph canvas                        │  fills remaining height
│                                              [minimap] │
├────────────────────────────────────────────────────────┤
│ Overview · YAML · Events            web-svc  Service   │  bottom panel, 280 px default,
│ …                                                      │  draggable, collapsible
└────────────────────────────────────────────────────────┘
```

**Design tokens** (from the n8n style):

| Token | Value |
|---|---|
| `bg-void` | `#0e0918` |
| `bg-surface` | `#1a1624` |
| `bg-panel` | `#1b1728` |
| `bg-muted` | `#2c2834` (chips, badges) |
| `border` | `#3e3a46` |
| `text` | `#d1cece` |
| `text-muted` | `#9d9797` |
| `text-hi` | `#ffffff` |
| `accent-ember` | `linear-gradient(30deg, #fd8925, #ff0c00)` |
| `accent-current` | `linear-gradient(141deg, #077ac7, #6b21ef)` |
| `status-ok` | `#2ecc71` |
| `status-warn` | `#fd8925` |
| `status-err` | `#ff0c00` |
| radius | inputs/buttons 8, nodes 12, cards 16, pills 9999 |
| font | Inter (Geomanist is the style's primary but is commercial; Inter is its documented fallback) |
| spacing | 8 px base |

**Node card** (medium density): kind icon (gradient square with a letter, or a colored dot for Pod), kind label (uppercase, muted), name (white), then a row of 0–2 pill badges. Selected: ember outline + soft glow. Hovering a node brightens its edges and dims the rest. Edges: 1.5 px, `accent-current` gradient, smooth bezier; `owns` edges solid, all others dashed.

**Canvas**: dot grid on `bg-void`, subtle violet radial glow, React Flow controls and minimap bottom-right, pan/zoom with mouse and trackpad.

**Bottom panel**: tabs Overview · YAML · Events; header shows name and kind; Events tab marks `Warning` rows with `status-warn`. Empty selection: "Select a node to see details".

**Platform specifics**: macOS uses `titleBarStyle: Overlay` with traffic lights inset into the header; Windows uses standard decorations. Shortcuts use `Cmd` on macOS and `Ctrl` on Windows.

**Language**: all UI text, docs, commits and release notes are in English.

## 8. Error handling

- All backend errors are `AppError { kind: Auth | Network | Forbidden | NotFound | Internal, message }`, serialized to the frontend and shown as a toast.
- A `Forbidden` (403) on a specific kind does not fail the session: that watcher is dropped, the kind chip shows a "no access" marker, and the graph is built without it.
- Missing exec plugin binary → `Auth` error naming the binary.
- Every watcher runs in its own tokio task; a panic is caught, logged via `tracing`, and reported as `Internal` — the app never crashes because of one stream.
- Frontend: a React error boundary around the canvas and around the details panel, each with a "Reload view" action.

## 9. Testing

- **`graph` (Rust)** — the core suite, written test-first. Fixtures are YAML files under `src-tauri/tests/fixtures/` loaded into a `Store`. Cases: owner chains (Deployment → RS → Pod, hidden single RS), Service selector matching (including no-match warn), Ingress rules and default backend, volumes/envFrom/projected sources, PVC/PV binding, ServiceAccount default, HPA target, every status rule, PodGroup collapse/expand and edge aggregation, `diff` producing minimal deltas (add/update/remove, unchanged → empty delta).
- **`kubeconfig` (Rust)** — multiple files, `KUBECONFIG` with `:` and `;`, duplicate context names across files (first file wins, as kubectl does; source recorded), unparseable files skipped with a warning, missing file.
- **`commands` (Rust)** — IPC fixture test: serialize one sample of every payload type and compare with `src/shared/ipc/fixtures/*.json` so the TypeScript mirror cannot drift silently.
- **Frontend (Vitest)** — zustand store: apply snapshot/delta, selection survival, filters; layout worker: kind → layer mapping, hidden nodes excluded; node badge/status rendering.
- **Smoke (CI, Linux runner)** — spin up `kind`, apply a fixture namespace, run the Rust session against it headless (no Tauri window) and assert the snapshot contains the expected nodes and edges.

## 10. Build and distribution

- `pnpm tauri dev` for local development on macOS.
- GitHub Actions on tag `v*`: `tauri-action` matrix — `macos-latest` builds a universal `.dmg`; `windows-latest` builds `.msi` (WiX) and `.exe` (NSIS). Artifacts attached to a GitHub Release.
- Unsigned in the MVP. README documents `xattr -d com.apple.quarantine` for macOS and the SmartScreen "Run anyway" step for Windows.
- Version `0.1.0`; Rust stable, Node 22, pnpm 9.

## 11. Decisions log

| Decision | Chosen | Alternatives considered |
|---|---|---|
| MVP focus | Graph first | Mini-Lens first; graph + tables together |
| Stack | Tauri 2 + React + Rust/kube-rs | Electron + Node; .NET WinUI/Avalonia |
| Graph layout | Hierarchical left→right (ELK layered) | Force-directed; radial focus mode |
| Window layout | Canvas top, details panel bottom | Three columns; full-screen canvas with overlay panel |
| Relationships | Full set (owners, selectors, ingress, mounts/env, PVC/PV, SA, HPA) | Reduced set; plus NetworkPolicy/RBAC |
| Updates | Live via watch | Manual refresh; live statuses only |
| Clusters | One active, switch via context list | Multiple in tabs |
| Scope | One namespace, pods collapse into groups | No collapsing; all-namespaces mode |
| Details panel | Overview · YAML · Events | YAML only; plus logs |
| Node density | Medium (badges row) | Compact; rich mini-card |
| Name | Wiring | Kubegraph; Lumen |
