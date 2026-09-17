# Navigator and Table Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Lens-style left Navigator (clusters + resource category tree with live counts/status) and per-kind table views switchable with the graph, backed by a new `list_rows` backend command.

**Architecture:** Backend gains a pure `graph::rows` module (per-kind kubectl-like columns computed from the cached `Store`) exposed as `list_rows`. Frontend gains `view` state in the store, a `Navigator` feature (clusters + tree, counts derived from graph nodes), a `table` feature (sortable/filterable table, row selection, show-in-graph), and a centre `ViewHeader` with a Graph/Table switch. Tables refresh on graph deltas touching their kind.

**Tech Stack:** unchanged (Rust/kube-rs + k8s-openapi 0.28 with `jiff`; React 19, zustand 5, Tailwind 4, Vitest).

**Spec:** `docs/superpowers/specs/2026-09-18-navigator-tables-design.md`. Base: `master` @ `9bbac6b`.

---

## File structure

```
src-tauri/src/graph/rows.rs            Table types + table(store, kind, now) + age()
src-tauri/src/commands.rs              + list_rows command
src-tauri/tests/ipc_fixtures.rs        + table fixture test
src/shared/ipc/fixtures/table.json     contract fixture
src/shared/ipc/types.ts                + Table types + guard
src/shared/ipc/commands.ts             + listRows
src/shared/settings.ts                 + sidebarCollapsed
src/app/store.ts                       + view, sidebarCollapsed, tables, focusRequest, actions, kindStats selector
src/app/wireEvents.ts                  + table refresh on snapshot/delta
src/features/navigator/kindTree.ts     sections → kinds, labels
src/features/navigator/Navigator.tsx   clusters + tree + collapse rail
src/features/table/TableView.tsx       sortable table
src/features/table/sort.ts             pure sort/filter helpers
src/features/graph/ViewHeader.tsx      breadcrumb + Graph|Table switch
src/features/graph/Canvas.tsx          + focusRequest handling
src/App.tsx                            layout: Navigator | (ViewHeader + centre) / DetailsPanel
```

---

### Task 1: Backend `graph::rows` + `list_rows`

**Files:**
- Create: `src-tauri/src/graph/rows.rs`, `src/shared/ipc/fixtures/table.json`
- Modify: `src-tauri/src/graph/mod.rs` (`pub mod rows;`), `src-tauri/src/session/mod.rs` (`Session::list_rows`), `src-tauri/src/commands.rs` (`list_rows` command + handler list), `src-tauri/tests/ipc_fixtures.rs`

- [ ] **Step 1: Failing tests** (bottom of `src-tauri/src/graph/rows.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Kind, Store};

    fn now() -> jiff::Timestamp {
        "2026-09-17T12:00:00Z".parse().unwrap()
    }

    fn cell<'a>(t: &'a Table, name: &str, col: &str) -> &'a TableCell {
        let ci = t.columns.iter().position(|c| c.key == col).expect("column");
        let row = t.rows.iter().find(|r| r.cells[0].text == name).expect("row");
        &row.cells[ci]
    }

    #[test]
    fn age_formats_like_kubectl() {
        let n = now();
        let at = |s: &str| Some(k8s_openapi::apimachinery::pkg::apis::meta::v1::Time(s.parse().unwrap()));
        assert_eq!(age(at("2026-09-17T11:59:15Z").as_ref(), n), "45s");
        assert_eq!(age(at("2026-09-17T11:48:00Z").as_ref(), n), "12m");
        assert_eq!(age(at("2026-09-17T09:00:00Z").as_ref(), n), "3h");
        assert_eq!(age(at("2026-09-13T12:00:00Z").as_ref(), n), "4d");
        assert_eq!(age(None, n), "—");
    }

    #[test]
    fn pod_table_has_kubectl_columns_and_statuses() {
        let s = Store::from_fixture("statuses").unwrap();
        let t = table(&s, Kind::Pod, now());
        assert_eq!(t.kind, Kind::Pod);
        assert_eq!(t.columns.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), ["name", "ready", "status", "restarts", "age", "node", "ip"]);
        assert_eq!(cell(&t, "crashing", "status").text, "CrashLoopBackOff");
        assert_eq!(cell(&t, "crashing", "status").status, Some(Status::Err));
        assert_eq!(cell(&t, "crashing", "restarts").text, "14");
        assert_eq!(cell(&t, "notready", "ready").text, "1/2");
        assert_eq!(cell(&t, "running", "ready").text, "1/1");
        let names: Vec<&str> = t.rows.iter().map(|r| r.cells[0].text.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "rows sorted by name");
        assert!(t.rows.iter().all(|r| r.node_id.starts_with("Pod/s/")));
    }

    #[test]
    fn deployment_service_pvc_columns() {
        let s = Store::from_fixture("statuses").unwrap();
        let d = table(&s, Kind::Deployment, now());
        assert_eq!(cell(&d, "rolling", "ready").text, "2/3");
        assert_eq!(cell(&d, "rolling", "ready").status, Some(Status::Warn));
        assert_eq!(cell(&d, "healthy", "images").text, "nginx:1.27");
        let svc = table(&s, Kind::Service, now());
        assert_eq!(cell(&svc, "matched", "ports").text, "80/TCP");
        assert_eq!(cell(&svc, "orphan", "type").text, "NodePort");
        let pvc = table(&s, Kind::PersistentVolumeClaim, now());
        assert_eq!(cell(&pvc, "waiting", "status").status, Some(Status::Warn));
        assert_eq!(cell(&pvc, "data", "capacity").text, "10Gi");
        let cj = table(&s, Kind::CronJob, now());
        assert_eq!(cell(&cj, "nightly", "suspend").text, "true");
    }

    #[test]
    fn every_kind_has_name_first_and_aligned_cells() {
        let s = Store::from_fixture("statuses").unwrap();
        for kind in Kind::WATCHED {
            let t = table(&s, kind, now());
            assert_eq!(t.columns[0].key, "name", "{kind:?}");
            for r in &t.rows {
                assert_eq!(r.cells.len(), t.columns.len(), "{kind:?}");
            }
        }
    }

    #[test]
    fn pod_group_and_empty_kinds_yield_empty_tables() {
        let s = Store::default();
        assert!(table(&s, Kind::Pod, now()).rows.is_empty());
        assert!(table(&s, Kind::PodGroup, now()).rows.is_empty());
    }
}
```

- [ ] **Step 2: Run** `cargo test graph::rows` → module not found.

- [ ] **Step 3: Implement** `src-tauri/src/graph/rows.rs`

```rust
//! kubectl-like tables per kind, computed from the Store.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use serde::{Deserialize, Serialize};

use super::model::{node_id, NodeId, Status};
use super::status::describe;
use crate::store::{Kind, Object, Store};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableColumn {
    pub key: String,
    pub label: String,
    pub numeric: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableCell {
    pub text: String,
    pub status: Option<Status>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRow {
    pub node_id: NodeId,
    pub status: Status,
    pub cells: Vec<TableCell>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Table {
    pub kind: Kind,
    pub columns: Vec<TableColumn>,
    pub rows: Vec<TableRow>,
}

fn col(key: &str, label: &str, numeric: bool) -> TableColumn {
    TableColumn { key: key.into(), label: label.into(), numeric }
}
fn plain(text: impl Into<String>) -> TableCell {
    TableCell { text: text.into(), status: None }
}
fn coloured(text: impl Into<String>, status: Status) -> TableCell {
    TableCell { text: text.into(), status: Some(status) }
}

/// kubectl-style relative age.
pub fn age(created: Option<&Time>, now: jiff::Timestamp) -> String {
    let Some(t) = created else { return "—".into() };
    let secs = now.as_second() - t.0.as_second();
    let secs = secs.max(0);
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

pub fn columns(kind: Kind) -> Vec<TableColumn> {
    let name = || col("name", "Name", false);
    let age_c = || col("age", "Age", true);
    match kind {
        Kind::Pod => vec![name(), col("ready", "Ready", false), col("status", "Status", false), col("restarts", "Restarts", true), age_c(), col("node", "Node", false), col("ip", "IP", false)],
        Kind::Deployment => vec![name(), col("ready", "Ready", false), col("upToDate", "Up-to-date", true), col("available", "Available", true), age_c(), col("images", "Images", false)],
        Kind::StatefulSet => vec![name(), col("ready", "Ready", false), age_c(), col("images", "Images", false)],
        Kind::DaemonSet => vec![name(), col("desired", "Desired", true), col("ready", "Ready", true), age_c(), col("images", "Images", false)],
        Kind::ReplicaSet => vec![name(), col("desired", "Desired", true), col("current", "Current", true), col("ready", "Ready", true), age_c()],
        Kind::Job => vec![name(), col("completions", "Completions", false), age_c()],
        Kind::CronJob => vec![name(), col("schedule", "Schedule", false), col("suspend", "Suspend", false), col("active", "Active", true), col("lastSchedule", "Last schedule", true), age_c()],
        Kind::ConfigMap => vec![name(), col("keys", "Keys", true), age_c()],
        Kind::Secret => vec![name(), col("type", "Type", false), col("keys", "Keys", true), age_c()],
        Kind::HorizontalPodAutoscaler => vec![name(), col("target", "Target", false), col("min", "Min", true), col("max", "Max", true), col("replicas", "Replicas", true), age_c()],
        Kind::Service => vec![name(), col("type", "Type", false), col("clusterIp", "Cluster IP", false), col("ports", "Ports", false), age_c()],
        Kind::Ingress => vec![name(), col("class", "Class", false), col("hosts", "Hosts", false), age_c()],
        Kind::PersistentVolumeClaim => vec![name(), col("status", "Status", false), col("volume", "Volume", false), col("capacity", "Capacity", false), col("accessModes", "Access modes", false), col("storageClass", "StorageClass", false), age_c()],
        Kind::PersistentVolume => vec![name(), col("capacity", "Capacity", false), col("accessModes", "Access modes", false), col("reclaim", "Reclaim", false), col("status", "Status", false), col("claim", "Claim", false), col("storageClass", "StorageClass", false), age_c()],
        Kind::ServiceAccount => vec![name(), age_c()],
        Kind::PodGroup => vec![],
    }
}

/// Build the table for `kind` from the store. Rows sorted by name.
pub fn table(store: &Store, kind: Kind, now: jiff::Timestamp) -> Table {
    let columns = columns(kind);
    let mut rows: Vec<TableRow> = store
        .iter_kind(kind)
        .map(|obj| {
            let (status, badges) = describe(obj, store);
            let mut cells = vec![plain(obj.name())];
            cells.extend(kind_cells(obj, &badges, status, now));
            TableRow { node_id: node_id(kind, obj.namespace(), obj.name()), status, cells }
        })
        .collect();
    rows.sort_by(|a, b| a.cells[0].text.cmp(&b.cells[0].text));
    Table { kind, columns, rows }
}

fn images(containers: &[k8s_openapi::api::core::v1::Container]) -> String {
    containers.iter().filter_map(|c| c.image.clone()).collect::<Vec<_>>().join(", ")
}

fn join<T: ToString>(items: Option<&Vec<T>>) -> String {
    items.map(|v| v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")).unwrap_or_default()
}

fn kind_cells(obj: &Object, badges: &[String], status: Status, now: jiff::Timestamp) -> Vec<TableCell> {
    let created = obj.meta().creation_timestamp.as_ref();
    let age_cell = plain(age(created, now));
    match obj {
        Object::Pod(p) => {
            let st = p.status.as_ref();
            let statuses = st.and_then(|s| s.container_statuses.as_ref()).cloned().unwrap_or_default();
            let total = p.spec.as_ref().map(|s| s.containers.len()).unwrap_or(0);
            let ready = statuses.iter().filter(|c| c.ready).count();
            let restarts: i32 = statuses.iter().map(|c| c.restart_count).sum();
            let label = badges.first().cloned().unwrap_or_default();
            vec![
                plain(format!("{ready}/{total}")),
                coloured(label, status),
                plain(restarts.to_string()),
                age_cell,
                plain(p.spec.as_ref().and_then(|s| s.node_name.clone()).unwrap_or_default()),
                plain(st.and_then(|s| s.pod_ip.clone()).unwrap_or_default()),
            ]
        }
        Object::Deployment(d) => {
            let st = d.status.as_ref();
            let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let ready = st.and_then(|s| s.ready_replicas).unwrap_or(0);
            vec![
                coloured(format!("{ready}/{desired}"), status),
                plain(st.and_then(|s| s.updated_replicas).unwrap_or(0).to_string()),
                plain(st.and_then(|s| s.available_replicas).unwrap_or(0).to_string()),
                age_cell,
                plain(d.spec.as_ref().and_then(|s| s.template.spec.as_ref()).map(|ps| images(&ps.containers)).unwrap_or_default()),
            ]
        }
        Object::StatefulSet(s) => {
            let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let ready = s.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
            vec![
                coloured(format!("{ready}/{desired}"), status),
                age_cell,
                plain(s.spec.as_ref().and_then(|s| s.template.spec.as_ref()).map(|ps| images(&ps.containers)).unwrap_or_default()),
            ]
        }
        Object::DaemonSet(d) => {
            let st = d.status.as_ref();
            vec![
                plain(st.map(|s| s.desired_number_scheduled).unwrap_or(0).to_string()),
                coloured(st.map(|s| s.number_ready).unwrap_or(0).to_string(), status),
                age_cell,
                plain(d.spec.as_ref().and_then(|s| s.template.spec.as_ref()).map(|ps| images(&ps.containers)).unwrap_or_default()),
            ]
        }
        Object::ReplicaSet(r) => {
            let st = r.status.as_ref();
            vec![
                plain(r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1).to_string()),
                plain(st.map(|s| s.replicas).unwrap_or(0).to_string()),
                coloured(st.and_then(|s| s.ready_replicas).unwrap_or(0).to_string(), status),
                age_cell,
            ]
        }
        Object::Job(_) => vec![coloured(badges.first().cloned().unwrap_or_default(), status), age_cell],
        Object::CronJob(c) => {
            let st = c.status.as_ref();
            vec![
                plain(c.spec.schedule.clone()),
                plain(c.spec.suspend.unwrap_or(false).to_string()),
                plain(st.and_then(|s| s.active.as_ref()).map(|a| a.len()).unwrap_or(0).to_string()),
                plain(age(st.and_then(|s| s.last_schedule_time.as_ref()), now)),
                age_cell,
            ]
        }
        Object::ConfigMap(c) => vec![
            plain((c.data.as_ref().map_or(0, |d| d.len()) + c.binary_data.as_ref().map_or(0, |d| d.len())).to_string()),
            age_cell,
        ],
        Object::Secret(s) => vec![
            plain(s.type_.clone().unwrap_or_default()),
            plain((s.data.as_ref().map_or(0, |d| d.len()) + s.string_data.as_ref().map_or(0, |d| d.len())).to_string()),
            age_cell,
        ],
        Object::HorizontalPodAutoscaler(h) => {
            let st = h.status.as_ref();
            vec![
                plain(format!("{}/{}", h.spec.scale_target_ref.kind, h.spec.scale_target_ref.name)),
                plain(h.spec.min_replicas.unwrap_or(1).to_string()),
                plain(h.spec.max_replicas.to_string()),
                coloured(st.and_then(|s| s.current_replicas).unwrap_or(0).to_string(), status),
                age_cell,
            ]
        }
        Object::Service(s) => {
            let spec = s.spec.as_ref();
            let ports = spec
                .and_then(|s| s.ports.as_ref())
                .map(|ps| ps.iter().map(|p| format!("{}/{}", p.port, p.protocol.clone().unwrap_or_else(|| "TCP".into()))).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            vec![
                plain(spec.and_then(|s| s.type_.clone()).unwrap_or_else(|| "ClusterIP".into())),
                plain(spec.and_then(|s| s.cluster_ip.clone()).unwrap_or_default()),
                plain(ports),
                age_cell,
            ]
        }
        Object::Ingress(i) => {
            let spec = i.spec.as_ref();
            let hosts = spec
                .and_then(|s| s.rules.as_ref())
                .map(|r| r.iter().filter_map(|r| r.host.clone()).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            vec![plain(spec.and_then(|s| s.ingress_class_name.clone()).unwrap_or_default()), plain(hosts), age_cell]
        }
        Object::PersistentVolumeClaim(p) => {
            let spec = p.spec.as_ref();
            let st = p.status.as_ref();
            vec![
                coloured(st.and_then(|s| s.phase.clone()).unwrap_or_default(), status),
                plain(spec.and_then(|s| s.volume_name.clone()).unwrap_or_default()),
                plain(st.and_then(|s| s.capacity.as_ref()).and_then(|c| c.get("storage")).map(|q| q.0.clone())
                    .or_else(|| spec.and_then(|s| s.resources.as_ref()).and_then(|r| r.requests.as_ref()).and_then(|r| r.get("storage")).map(|q| q.0.clone()))
                    .unwrap_or_default()),
                plain(join(spec.and_then(|s| s.access_modes.as_ref()))),
                plain(spec.and_then(|s| s.storage_class_name.clone()).unwrap_or_default()),
                age_cell,
            ]
        }
        Object::PersistentVolume(p) => {
            let spec = p.spec.as_ref();
            vec![
                plain(spec.and_then(|s| s.capacity.as_ref()).and_then(|c| c.get("storage")).map(|q| q.0.clone()).unwrap_or_default()),
                plain(join(spec.and_then(|s| s.access_modes.as_ref()))),
                plain(spec.and_then(|s| s.persistent_volume_reclaim_policy.clone()).unwrap_or_default()),
                plain(p.status.as_ref().and_then(|s| s.phase.clone()).unwrap_or_default()),
                plain(spec.and_then(|s| s.claim_ref.as_ref()).map(|c| format!("{}/{}", c.namespace.clone().unwrap_or_default(), c.name.clone().unwrap_or_default())).unwrap_or_default()),
                plain(spec.and_then(|s| s.storage_class_name.clone()).unwrap_or_default()),
                age_cell,
            ]
        }
        Object::ServiceAccount(_) => vec![age_cell],
    }
}
```

Add `pub mod rows;` to `graph/mod.rs`. `Session::list_rows(&self, kind: Kind) -> Table` = `rows::table(&self.shared.store(), kind, jiff::Timestamp::now())`. Command in `commands.rs`: `#[tauri::command] pub async fn list_rows(state: State<'_, AppState>, kind: Kind) -> AppResult<Table>` via `session_mut` + register in `generate_handler!`. `jiff` is a dependency of k8s-openapi — add `jiff = "0.2"` (match the version k8s-openapi 0.28 uses: check `cargo tree -p k8s-openapi | grep jiff`) to `[dependencies]` if `k8s_openapi::jiff` is not re-exported (it is: use `k8s_openapi::jiff::Timestamp` and avoid the extra dependency if that compiles).

- [ ] **Step 4: IPC fixture** `src/shared/ipc/fixtures/table.json`

```json
{
  "kind": "Pod",
  "columns": [
    { "key": "name", "label": "Name", "numeric": false },
    { "key": "status", "label": "Status", "numeric": false },
    { "key": "restarts", "label": "Restarts", "numeric": true }
  ],
  "rows": [
    {
      "nodeId": "Pod/payments/web-1",
      "status": "err",
      "cells": [
        { "text": "web-1", "status": null },
        { "text": "CrashLoopBackOff", "status": "err" },
        { "text": "14", "status": null }
      ]
    }
  ]
}
```

Add to `src-tauri/tests/ipc_fixtures.rs`:
```rust
#[test]
fn table() {
    use wiring_lib::graph::rows::{Table, TableCell, TableColumn, TableRow};
    let t = Table {
        kind: Kind::Pod,
        columns: vec![
            TableColumn { key: "name".into(), label: "Name".into(), numeric: false },
            TableColumn { key: "status".into(), label: "Status".into(), numeric: false },
            TableColumn { key: "restarts".into(), label: "Restarts".into(), numeric: true },
        ],
        rows: vec![TableRow {
            node_id: "Pod/payments/web-1".into(),
            status: Status::Err,
            cells: vec![
                TableCell { text: "web-1".into(), status: None },
                TableCell { text: "CrashLoopBackOff".into(), status: Some(Status::Err) },
                TableCell { text: "14".into(), status: None },
            ],
        }],
    };
    assert_matches("table", &t);
}
```

- [ ] **Step 5: Verify** `cargo test` (all green, +6), `cargo clippy --all-targets -- -D warnings`, `cargo fmt`. Update `docs/ipc-contract.md`: add `list_rows` row to the commands table and a short "Table" section (shape + kubectl-like columns, rows sorted by name, PodGroup not a table kind).

- [ ] **Step 6: Commit** `Add per-kind tables and the list_rows command`

---

### Task 2: Frontend IPC + store state for views and tables

**Files:**
- Modify: `src/shared/ipc/types.ts`, `src/shared/ipc/commands.ts`, `src/shared/ipc/fixtures.test.ts`, `src/shared/settings.ts`, `src/app/store.ts`, `src/app/store.test.ts`, `src/app/wireEvents.ts`, `src/app/wireEvents.test.ts`

- [ ] **Step 1: Types + guard** — in `types.ts` add:
```ts
export interface TableColumn { key: string; label: string; numeric: boolean }
export interface TableCell { text: string; status: Status | null }
export interface TableRow { nodeId: NodeId; status: Status; cells: TableCell[] }
export interface Table { kind: Kind; columns: TableColumn[]; rows: TableRow[] }
export function isTable(v: unknown): v is Table { /* shallow: kind in KINDS, arrays, each row cells.length === columns.length */ }
```
`commands.ts`: `listRows: (kind: Kind) => call<Table>("list_rows", { kind })`. Fixture test: `it("table", () => expect(isTable(table)).toBe(true))` + a rejection case (cell count mismatch).

- [ ] **Step 2: Failing store tests** (`store.test.ts`) — add:
```ts
describe("views", () => {
  it("starts on the graph and switches to a table, fetching rows", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      cmd === "list_rows" ? { kind: args.kind, columns: [{ key: "name", label: "Name", numeric: false }], rows: [] } : null);
    expect(useAppStore.getState().view).toEqual({ name: "graph" });
    await useAppStore.getState().showTable("Pod");
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Pod" });
    expect(invoke).toHaveBeenCalledWith("list_rows", { kind: "Pod" });
    expect(useAppStore.getState().tables.get("Pod")?.columns[0].key).toBe("name");
    useAppStore.getState().showGraph();
    expect(useAppStore.getState().view).toEqual({ name: "graph" });
  });

  it("refreshTable keeps the table when the fetch fails and toasts", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "internal", message: "nope" });
    await useAppStore.getState().refreshTable("Pod");
    expect(useAppStore.getState().tables.has("Pod")).toBe(false);
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("nope");
  });

  it("focusInGraph switches to the graph, selects the node and bumps the focus request", async () => {
    useAppStore.setState(applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }));
    await useAppStore.getState().showTable("Pod");
    await useAppStore.getState().focusInGraph("Pod/p/a");
    const s = useAppStore.getState();
    expect(s.view).toEqual({ name: "graph" });
    expect(s.selectedId).toBe("Pod/p/a");
    expect(s.focusRequest).toEqual({ nodeId: "Pod/p/a", seq: 1 });
    await s.focusInGraph("Pod/p/a");
    expect(useAppStore.getState().focusRequest?.seq).toBe(2);
  });

  it("toggleSidebar flips and persists", async () => {
    await useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });

  it("selectNamespace and disconnect clear tables but keep the view kind", async () => {
    useAppStore.setState({ tables: new Map([["Pod", { kind: "Pod", columns: [], rows: [] }]]), view: { name: "table", kind: "Pod" }, connection: { ...initialState().connection, context: "prod" } });
    await useAppStore.getState().selectNamespace("payments");
    expect(useAppStore.getState().tables.size).toBe(0);
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Pod" });
  });
});

describe("kindStats", () => {
  it("counts nodes per kind with the worst status; PodGroup counts as pods", () => {
    const s = applySnapshot(initialState(), { nodes: [
      node("Pod/p/a"), node("Pod/p/b", { status: "err" }),
      node("PodGroup/p/Deployment/w", { kind: "PodGroup", status: "warn", group: { count: 7, ok: 6, warn: 1, err: 0 } }),
      node("Service/p/s", { kind: "Service" }),
    ], edges: [] });
    const stats = kindStats(s.nodes);
    expect(stats.get("Pod")).toEqual({ count: 9, worst: "err" });
    expect(stats.get("Service")).toEqual({ count: 1, worst: "ok" });
    expect(stats.has("PodGroup")).toBe(false);
  });
});
```
(`settings` is mocked in this file via `vi.mock("../shared/settings", ...)` — add it with `get/set/getLastNamespace/setLastNamespace/getSidebarCollapsed/setSidebarCollapsed` stubs.)

- [ ] **Step 3: Implement store**
- State: `view: View`, `sidebarCollapsed: boolean`, `tables: Map<Kind, Table>`, `focusRequest: { nodeId: NodeId; seq: number } | null`.
- `initialState()` sets `view: { name: "graph" }`, `sidebarCollapsed: false`, `tables: new Map()`, `focusRequest: null`. `disconnectedState` keeps `sidebarCollapsed`. `connect` success keeps `sidebarCollapsed` and resets `view` to graph. `selectNamespace` clears `tables` (keeps `view`); after `select_namespace` succeeds, if `view.name === "table"` call `refreshTable(view.kind)`.
- Actions: `showGraph()`; `showTable(kind)` sets view then `await refreshTable(kind)`; `refreshTable(kind)` → `commands.listRows(kind)` → set `tables` (new Map) else toast; `focusInGraph(id)` → `showGraph()`, `await select(id)`, `focusRequest = { nodeId, seq: (prev?.seq ?? 0) + 1 }`; `toggleSidebar()` flips and `settings.setSidebarCollapsed(next)`.
- `export function kindStats(nodes: Map<NodeId, GraphNode>): Map<Kind, { count: number; worst: Status }>` — worst via rank `unknown < ok < warn < err`; PodGroup adds `group.count` to `Pod` with the group's status.
- `settings.ts`: `getSidebarCollapsed(): Promise<boolean>`, `setSidebarCollapsed(v)`; `startup.ts` reads it into the store before connecting.

- [ ] **Step 4: wireEvents** — `graph_snapshot`: after applying, if `view.name === "table"` → `refreshTable(view.kind)`. `graph_delta`: after applying, if `view.name === "table"` and the delta touches that kind (any node in added/updated with `kind === view.kind`, or a removed id starting with `${view.kind}/`, or — for Pod — any `PodGroup` node) → debounced (300 ms, trailing) `refreshTable`. Export the pure `deltaTouches(delta, kind): boolean` and test it; test the debounce with `vi.useFakeTimers()`.

- [ ] **Step 5: Verify** `pnpm typecheck && pnpm test`; commit `Add view state, tables and kind statistics to the store`.

---

### Task 3: Navigator

**Files:**
- Create: `src/features/navigator/kindTree.ts`, `src/features/navigator/Navigator.tsx`, `src/features/navigator/Navigator.test.tsx`
- Modify: `src/App.tsx` (layout), `src/features/cluster/ContextPicker.tsx` (only shown when `pickerOpen`; unchanged otherwise), `src/features/cluster/Header.tsx` (context button toggles the sidebar instead of the picker when contexts exist)

- [ ] **Step 1: `kindTree.ts`**
```ts
import type { Kind } from "../../shared/ipc/types";
export interface Section { id: string; label: string; kinds: Kind[] }
export const SECTIONS: Section[] = [
  { id: "workloads", label: "Workloads", kinds: ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"] },
  { id: "config", label: "Config", kinds: ["ConfigMap", "Secret", "HorizontalPodAutoscaler"] },
  { id: "network", label: "Network", kinds: ["Service", "Ingress"] },
  { id: "storage", label: "Storage", kinds: ["PersistentVolumeClaim", "PersistentVolume"] },
  { id: "access", label: "Access Control", kinds: ["ServiceAccount"] },
];
export const KIND_PLURAL: Record<Kind, string> = { Pod: "Pods", Deployment: "Deployments", StatefulSet: "Stateful Sets", DaemonSet: "Daemon Sets", ReplicaSet: "Replica Sets", Job: "Jobs", CronJob: "Cron Jobs", ConfigMap: "Config Maps", Secret: "Secrets", HorizontalPodAutoscaler: "HPAs", Service: "Services", Ingress: "Ingresses", PersistentVolumeClaim: "Persistent Volume Claims", PersistentVolume: "Persistent Volumes", ServiceAccount: "Service Accounts", PodGroup: "Pods" };
export function sectionOf(kind: Kind): Section | undefined { return SECTIONS.find((s) => s.kinds.includes(kind)); }
```

- [ ] **Step 2: Failing tests** `Navigator.test.tsx` — mock `../../shared/ipc/tauri`, `../../shared/settings`, `@tauri-apps/plugin-dialog`. Cases: (a) lists contexts, highlights the connected one, click on another calls `connect` (mock via `setState({ connect })`); (b) shows sections with kinds, counts from `kindStats` (snapshot with 2 pods + 1 err pod → "Pods" row shows `3` and an err dot); (c) denied kind (`deniedKinds = Set(["Secret"])`) row has `line-through` class and title "No access (RBAC)"; (d) clicking "Pods" calls `showTable("Pod")`, clicking "Overview" calls `showGraph()`; active row has `aria-current="page"`; (e) collapsed mode renders only icons (no "Workloads" text) and the toggle calls `toggleSidebar`; (f) section header click collapses its kinds.

- [ ] **Step 3: Implement `Navigator.tsx`** — `<aside>` `w-60` (or `w-12` when collapsed) `border-r border-border bg-void flex flex-col`. Top: section label "Clusters" + one button per context (`Dot` for the connected one, name, cluster in muted) + "Add kubeconfig…" (same `open()` dialog flow as ContextPicker — extract `useAddKubeconfig()` hook into `features/cluster/useAddKubeconfig.ts` shared by both). Middle (scrollable): "Overview" row (graph icon) then `SECTIONS` with a chevron toggle per section; each kind row: `KIND_PLURAL` label, count (`kindStats`), status `Dot` (worst), struck-through when denied. Active row = `view.name === "table" && view.kind === kind` or Overview when graph. Bottom: collapse toggle (`ChevronsLeft/Right` from lucide). Collapsed: rail with the cluster dot, section initials, and the toggle; kind rows hidden.
- `App.tsx`: `<div className="flex h-full"> <Navigator/> <div className="flex min-w-0 flex-1 flex-col"> <Header/> <main>…</main> <DetailsPanel/> </div> </div>` — Header moves inside the right column; keep `drag-region` on Header and add it to the Navigator's top 48 px (`pt-12` spacer on macOS for traffic lights: the Navigator gets the `pl-20`-equivalent — put the traffic-light inset in the Navigator instead of the Header when the Navigator is visible).
- `Header.tsx`: the context button now toggles the sidebar (`toggleSidebar`) when contexts exist; keeps opening the picker when `contexts.length === 0`.

- [ ] **Step 4: Verify** `pnpm typecheck && pnpm test`; commit `Add the Navigator with clusters and the resource tree`.

---

### Task 4: Table view, view header, focus in graph

**Files:**
- Create: `src/features/table/sort.ts`, `src/features/table/sort.test.ts`, `src/features/table/TableView.tsx`, `src/features/table/TableView.test.tsx`, `src/features/graph/ViewHeader.tsx`
- Modify: `src/features/graph/Canvas.tsx` (focusRequest), `src/App.tsx` (centre switch)

- [ ] **Step 1: `sort.ts` (pure) + tests**
```ts
export type SortState = { key: string; dir: "asc" | "desc" } | null;
export function compareCells(a: string, b: string, numeric: boolean): number  // numeric: parse leading number (e.g. "14", "2/3" → 2, "45s"/"12m"/"3h"/"4d" → seconds); fallback localeCompare
export function sortRows(rows: TableRow[], columns: TableColumn[], sort: SortState): TableRow[]
export function filterRows(rows: TableRow[], query: string): TableRow[]   // case-insensitive substring over all cells
export function nextSort(current: SortState, key: string): SortState        // null→asc, asc→desc, desc→null
```
Tests: numeric age ordering (`45s` < `12m` < `3h` < `4d`), `2/3` before `3/3`, text fallback, filter, nextSort cycle, sort stability (equal keys keep name order).

- [ ] **Step 2: Failing `TableView.test.tsx`** — store with `view = table Pod`, `tables` containing 3 rows (columns name/status/restarts). Cases: renders headers and cells; status cell has `data-status="err"`; clicking "Restarts" header sorts desc-by-count on second click (assert row order); typing in the store `search` filters rows; row click calls `select(nodeId)`; selected row has `aria-selected="true"`; row double-click calls `focusInGraph(nodeId)`; empty rows → "No Pods in payments"; denied kind → "No access to Secrets (RBAC)".

- [ ] **Step 3: Implement `TableView.tsx`** — sticky header (`bg-panel`, uppercase muted labels, sort arrow), rows `hover:bg-muted/50`, selected `bg-muted` + left ember bar, `aria-selected`, status cells coloured via `text-status-*`, numeric columns right-aligned + `font-mono`. Keyboard: ↑/↓ moves selection, Enter = show in graph. Uses `useAppStore` (`view`, `tables`, `search`, `selectedId`, `deniedKinds`, `connection.namespace`, `select`, `focusInGraph`). Local `sort` state (reset when `view.kind` changes).

- [ ] **Step 4: `ViewHeader.tsx`** — breadcrumb (`Section / Kind · count` or `Overview · N objects`) on the left; segmented control `Graph | Table` on the right (Table disabled on Overview until a kind is chosen — it remembers the last table kind: store `lastTableKind: Kind | null`, set by `showTable`). Buttons `aria-pressed`.

- [ ] **Step 5: Canvas focus** — `useEffect` on `focusRequest?.seq`: `fitView({ nodes: [{ id: focusRequest.nodeId }], duration: 300, maxZoom: 1.2, padding: 0.5 })` (React Flow 12 `fitView` accepts `nodes` with ids). Test: rendering Canvas with a `focusRequest` doesn't throw (fitView is a no-op in jsdom).

- [ ] **Step 6: `App.tsx`** centre: `<ViewHeader/>` then `view.name === "graph" ? <Canvas/> : <TableView/>` inside the graph ErrorBoundary (rename to "main view").

- [ ] **Step 7: Verify** `pnpm typecheck && pnpm test && pnpm build`; commit `Add table views with sorting, filtering and show-in-graph`.

---

### Task 5: Live check, polish, docs

- [ ] **Step 1:** `pnpm tauri dev` against `docker-desktop` / `shop` (demo cluster, `examples/demo/setup.sh` already applied). Walk: Navigator counts match `kubectl get`; Pods table shows CrashLoopBackOff red, restarts; sort by Restarts; search `web`; row click → details; double-click → graph centres on the pod; Secrets table on `wiring-viewer` shows the RBAC empty state; collapse sidebar; Reconnect keeps the table view; live: `kubectl -n shop scale deploy/web --replicas=1` updates the table within a second.
- [ ] **Step 2:** fix what you find (with tests), update `docs/ipc-contract.md` (done in Task 1), README (Navigator/tables one paragraph + `list_rows`), spec §7 of the MVP spec gets a pointer to the new spec.
- [ ] **Step 3:** commit `Polish navigator and tables after live run`.

## Done criteria

`cargo test` (+6) and `pnpm test` (≈+35) green, clippy/fmt clean, live walkthrough done on macOS, merged to `master`.
