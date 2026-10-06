# Wiring — Several namespaces and "All namespaces"

**Date:** 2026-10-06
**Status:** approved
**Builds on:** v0.3.0 + the container terminal (branch `feat/exec`).

## 1. Goal

See more than one namespace at a time: pick several namespaces, or **All namespaces**, and get one graph, one set of tables and one navigator over all of them — the `kubectl get -A` view, with the wiring.

## 2. Non-goals

Cross-cluster views, saved namespace sets, label-based namespace filters, per-namespace colour coding beyond the lane header, cluster-scoped kinds other than the PersistentVolumes already shown.

## 3. User flows

- **Picker.** The namespace picker becomes a multi-select: a checkbox per namespace, **All namespaces** at the top, a filter box. Selecting one namespace behaves exactly as today. The header shows `shop`, `shop, blog` or `All namespaces (12)`. The choice is remembered per kubeconfig context.
- **Graph.** With more than one namespace the graph is laid out in **lanes**: one framed group per namespace with its name in the frame header; objects are laid out inside their lane as today; edges that cross namespaces (e.g. a PV bound to a PVC) are drawn between lanes. Empty namespaces get no lane. Kind chips, search (⌘K) and status work across all lanes.
- **Large graphs.** When the selection has more than 1 500 visible nodes the graph is not rendered; the view says *1 873 objects — too many for the graph. Use the tables, or pick fewer namespaces.* and switches to the table view. Tables always work.
- **Tables and navigator.** With more than one namespace the tables get a leading **Namespace** column (sortable, filterable by the search box); the navigator counts and worst-status dots cover the whole selection.
- **Everything else** keeps working per object, using the object's own namespace: details, YAML edit, Events, Logs, Terminal, Actions (scale/restart/rollback/port-forward/delete), Problem explanations, metrics. **+ Create** gets a **Namespace** select, defaulting to the first selected namespace (the manifest's own `metadata.namespace` still wins, as today).
- **RBAC.** *All namespaces* needs cluster-wide `list`/`watch`. If a kind is forbidden cluster-wide, Wiring falls back to watching that kind per namespace in the listed namespaces it can read, and the navigator marks it as *partial*. If even listing namespaces is forbidden, *All namespaces* is not offered (free-text namespaces, as today).

## 4. Backend

- `select_namespace { namespace }` becomes `select_namespaces { namespaces: string[] | "all", expandedGroups }`; the old command stays as a thin wrapper for one namespace until the frontend no longer uses it, then is removed in the same branch.
- The namespace session holds a `NamespaceScope = All | Set(BTreeSet<String>)`. Watchers per kind:
  - `All` → one cluster-wide watcher (`Api::all`); on 403 → per-namespace watchers over the namespaces the user can list, kind marked `partial`.
  - `Set` → one namespaced watcher per (kind, namespace). A set of one is today's behaviour.
- The store already keys objects by namespace; relations are computed within a namespace except the existing PV ↔ PVC binding. Graph nodes carry their namespace (already in the id).
- Metrics poller: `All` → one cluster-wide `PodMetrics` list; `Set` → one list per namespace per tick.
- Graph build gains lane metadata: each node's `namespace` is already present; the frontend lays lanes out. The 1 500-node guard is applied in the backend snapshot (`tooLarge: true` with the count, nodes omitted) so huge graphs never cross IPC.
- `denied_kinds` reports `partial` kinds alongside denied ones.
- Settings: last selection per context (`settings.json`, `namespacesByContext`).

## 5. Frontend

- `NamespacePicker` (multi-select, All, filter, per-context persistence) replaces the single select.
- Graph layout: lanes as React Flow parent (group) nodes, children positioned by the existing layered layout per lane, lanes stacked vertically in name order; lane header shows the namespace name and object count.
- Tables: Namespace column when the scope has > 1 namespace.
- Create dialog: namespace select.
- `tooLarge` snapshot → notice + table view.

## 6. Testing

- **Rust:** scope parsing/validation, watcher plan for `All` / `Set` / 403 fallback (fake API), metrics plan per scope, tooLarge guard threshold, relations stay within a namespace (plus PV ↔ PVC), settings round-trip.
- **Smoke (docker-desktop only):** select `wiring-smoke` + a second fixture namespace, check both appear (graph nodes and a table's Namespace column), then `All`, check `kube-system` objects appear; single-namespace steps unchanged.
- **Vitest:** picker (multi-select, All, filter, persistence), lane layout (groups, children inside, cross-lane edges), tooLarge notice, Namespace column visibility, Create namespace select.

## 7. Decisions log

- Multi-select picker with *All namespaces*; remembered per context.
- One graph with a lane per namespace; > 1 500 nodes → tables only.
- `All` uses cluster-wide watches with a per-namespace fallback on 403; explicit sets use per-namespace watches.
- Everything object-level keeps using the object's own namespace; Create gets a namespace select.
