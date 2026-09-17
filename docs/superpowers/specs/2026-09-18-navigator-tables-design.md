# Wiring — Navigator and table views

**Date:** 2026-09-18
**Status:** approved
**Builds on:** `2026-09-17-wiring-mvp-design.md` (MVP, merged).

## 1. Goal

Add the Lens-style resource browser on top of the graph: a left **Navigator** with the cluster list and a category tree of resource kinds (with live counts and worst status), and a **table view** per kind in the centre, switchable with the graph. The graph stays the centrepiece ("Overview"); tables answer "show me all pods with restarts" style questions.

## 2. Non-goals

Nodes, Namespaces and Events as standalone views; Helm; CRDs; editing; column customisation; multi-select or bulk actions.

## 3. Window layout

```
┌ header (unchanged) ───────────────────────────────────────────────────────┐
├──────────┬────────────────────────────────────────────────────────────────┤
│ Navigator│ view header: breadcrumb "Workloads / Pods · 14"   [Graph|Table] │
│ 240 px   │ centre: graph canvas  |  table of the selected kind            │
│ (collaps-├────────────────────────────────────────────────────────────────┤
│ ible to  │ details panel (unchanged)                                      │
│ 48 px)   │                                                                │
└──────────┴────────────────────────────────────────────────────────────────┘
```

- Navigator collapses to a 48 px icon rail (toggle button at its bottom, state remembered in settings).
- The context-picker modal remains only for the empty state (no contexts) — cluster switching moves into the Navigator.

## 4. Navigator

**Clusters** section: every kubeconfig context (`list_contexts`), the connected one highlighted with the connection dot; click → `connect` (same flow as the picker, incl. auto-selecting the context's default namespace); "+ Add kubeconfig…" at the bottom of the section.

**Resource tree** (for the connected cluster / selected namespace):

| Section | Kinds |
|---|---|
| Overview | the graph |
| Workloads | Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs |
| Config | ConfigMaps, Secrets, HorizontalPodAutoscalers |
| Network | Services, Ingresses |
| Storage | PersistentVolumeClaims, PersistentVolumes |
| Access Control | ServiceAccounts |

Each kind row shows a count and a dot with the worst status among its objects (`err` > `warn` > `ok`), both derived from the graph nodes already in the store (PodGroup counts as its member count; individual pods when expanded). Kinds in `deniedKinds` are struck through with the "No access (RBAC)" title. Sections are collapsible (state in memory only). The active row (Overview or a kind) is highlighted.

## 5. Table view

- Opened by clicking a kind in the Navigator; the view header shows `Section / Kind · count` and a `Graph | Table` segmented control. `Graph` returns to Overview; the kind stays highlighted in the Navigator until Overview is clicked.
- Columns are `kubectl get`-like and defined in the backend (§7). Cells may carry a status colour (ok/warn/err). Rows are sorted by name by default; clicking a header sorts by that column (text, numeric-aware), a second click reverses.
- The header search box filters rows by substring across all cells (case-insensitive) — the same `search` state that dims graph nodes.
- Row click → `select(nodeId)` (details panel + events watcher). Selected row highlighted with the ember accent. Double-click or the row's "Show in graph" action → switches to Overview, selects the node and centres the canvas on it.
- Live: the table refreshes when a `graph_snapshot` arrives or a `graph_delta` touches the table's kind (debounced 300 ms). Sorting and selection survive refreshes.
- Empty state: "No <kind> in <namespace>". Denied kind: "No access to <kind> (RBAC)".

## 6. State (frontend)

```
view: { name: "graph" } | { name: "table", kind: Kind }
sidebarCollapsed: boolean            // persisted in settings.json as "sidebarCollapsed"
tables: Map<Kind, Table>             // last fetched table per kind
focusRequest: { nodeId, seq } | null // Canvas centres on nodeId when seq changes
```
Actions: `showGraph()`, `showTable(kind)`, `toggleSidebar()`, `refreshTable(kind)`, `focusInGraph(nodeId)`.
Derived (selector): `kindStats: Map<Kind, { count, worst }>` from `nodes`.

## 7. Backend: `list_rows`

New command `list_rows({ kind }) → Table`:

```
Table      { kind, columns: TableColumn[], rows: TableRow[] }
TableColumn{ key, label, numeric: bool }
TableRow   { nodeId, status, cells: TableCell[] }     // cells align with columns
TableCell  { text, status: Status | null }            // status colours the cell
```

Implemented as a pure function `graph::rows::table(store, kind, now) -> Table` (rows sorted by name; `now` injected for age tests). Columns per kind:

| Kind | Columns |
|---|---|
| Pod | Name, Ready (`n/m` containers), Status (label from `describe`, coloured), Restarts, Age, Node, IP |
| Deployment | Name, Ready (`ready/desired`, coloured), Up-to-date, Available, Age, Images |
| StatefulSet | Name, Ready (coloured), Age, Images |
| DaemonSet | Name, Desired, Ready (coloured), Age, Images |
| ReplicaSet | Name, Desired, Current, Ready (coloured), Age |
| Job | Name, Completions (`succeeded/completions`, coloured), Age |
| CronJob | Name, Schedule, Suspend, Active, Last schedule (age), Age |
| ConfigMap | Name, Keys, Age |
| Secret | Name, Type, Keys, Age |
| HorizontalPodAutoscaler | Name, Target (`Kind/name`), Min, Max, Replicas (coloured), Age |
| Service | Name, Type, Cluster IP, Ports (`80/TCP, 443/TCP`), Age |
| Ingress | Name, Class, Hosts, Age |
| PersistentVolumeClaim | Name, Status (coloured), Volume, Capacity, Access modes, StorageClass, Age |
| PersistentVolume | Name, Capacity, Access modes, Reclaim, Status, Claim (`ns/name`), StorageClass, Age |
| ServiceAccount | Name, Age |

`Age` uses kubectl's format (`45s`, `12m`, `3h`, `4d`). `PodGroup` is not a table kind; `list_rows({kind: "Pod"})` always lists individual pods (collapsing is a graph concern). Requesting a denied kind returns an empty table (the frontend shows the RBAC empty state from `deniedKinds`).

## 8. Testing

- Rust: `graph::rows` tests on the existing fixtures for every kind's columns and a few cells (Pod ready/restarts/status, Deployment ready, Service ports, PVC status), `age()` formatting, denied/empty kind.
- Frontend: store (view transitions, kindStats, focusRequest, table refresh on delta/snapshot), Navigator (sections, counts, worst-status dot, denied strike-through, cluster click → connect), TableView (sorting, search filter, row click → select, show-in-graph → view + focus), view header switch.
- Live check against the demo cluster (`shop`).

## 9. Decisions log

| Decision | Chosen | Alternatives |
|---|---|---|
| What a Navigator kind click does | Table view in the centre with Graph/Table switch | Filter the graph; table + graph side by side |
| Where columns are defined | Backend, per kind, tested on fixtures | Frontend from raw YAML |
| Live table updates | Refetch on delta touching the kind (debounced) | Dedicated row-delta events |
| Nodes / Events / Namespaces views | Deferred | Include now |
