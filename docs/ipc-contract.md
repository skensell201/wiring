# IPC contract — backend ↔ frontend

The JSON fixtures in `src/shared/ipc/fixtures/` are the authoritative payload shapes; a Rust test (`src-tauri/tests/ipc_fixtures.rs`) fails when a Rust type drifts from them. This page records what the fixtures alone do not say.

## Enum string values

| Type | Values |
|---|---|
| `Kind` | `Deployment`, `StatefulSet`, `DaemonSet`, `ReplicaSet`, `Job`, `CronJob`, `Pod`, `Service`, `Ingress`, `ConfigMap`, `Secret`, `PersistentVolumeClaim`, `PersistentVolume`, `ServiceAccount`, `HorizontalPodAutoscaler`, `PodGroup` |
| `Status` | `ok`, `warn`, `err`, `unknown` |
| `Relation` | `owns`, `selects`, `routes`, `mounts`, `envFrom`, `claims`, `binds`, `usesSA`, `scales` |
| `ErrorKind` | `auth`, `network`, `forbidden`, `notFound`, `conflict`, `invalid`, `internal` — `conflict` is HTTP 409 (stale `resourceVersion` on a write); `invalid` is HTTP 400/422 (the message is the server's, listing the bad fields) |
| `ConnectionState` | `connected`, `degraded`, `disconnected` |

## Commands (`invoke`)

Argument names are camelCase on the JS side; Tauri maps them to the Rust snake_case parameters.

| Command | Args | Returns |
|---|---|---|
| `list_contexts` | — | `ContextInfo[]` |
| `add_kubeconfig` | `{ path }` | `ContextInfo[]` — rejects with `AppError` if the file is missing or unparseable |
| `connect` | `{ context }` | `ConnectInfo` — a **rejected promise** carries the `AppError`; no `connection_error` event is sent for connect failures |
| `disconnect` | — | `null` |
| `select_namespace` | `{ namespace, expandedGroups: string[] }` | `null` — the graph arrives via events |
| `set_expanded_groups` | `{ expandedGroups: string[] }` | `null` |
| `get_object` | `{ nodeId }` | `ObjectDetails` (`summary` is an ordered `[string, string][]`) |
| `watch_events` | `{ nodeId: string \| null }` | `null` — `null` stops the current watcher |
| `denied_kinds` | — | `Kind[]` — kinds the session could not watch (RBAC 403 / API group missing) |
| `list_rows` | `{ kind }` | `Table` — kubectl-like columns/rows for `kind`, computed from the cached store |
| `update_object` | `{ nodeId, yaml, force: boolean }` | `ObjectDetails` — fresh YAML/summary of the saved object (see [Writes](#writes)) |
| `create_object` | `{ namespace, yaml }` | `NodeId` of the created object; it reaches the graph through the watch |
| `delete_object` | `{ nodeId }` | `null` — a PodGroup id deletes every member pod |

`ConnectInfo.namespaces` may be **empty** when the user cannot list namespaces (namespace-scoped RBAC); offer a free-text namespace input in that case. If the kubeconfig context has a default namespace it is included.

### Writes

- `update_object` parses `yaml` as exactly one document; its `kind`, `metadata.name` and `metadata.namespace` must match `nodeId`, otherwise the promise rejects with `invalid` before anything is sent (rename/move are not supported through editing). The object is replaced (`PUT`) with `fieldValidation=Strict`, so unknown or duplicate fields reject with `invalid` and the server's message lists them. With `force: false` the server enforces the manifest's `metadata.resourceVersion`: a stale one rejects with `conflict`. With `force: true` the current `resourceVersion` is fetched and copied in first, overwriting whatever changed in between. On success the saved object is placed in the store immediately, so the returned details (and the next `get_object`) are fresh before the watch echo arrives.
- `create_object` uses the manifest's own `metadata.namespace` when set, else `namespace`; both are ignored for cluster-scoped kinds (PersistentVolume). A missing `apiVersion` is filled in from the kind. Creating an existing object rejects with `conflict`; a kind outside the watched list with `invalid`.
- `delete_object` on `Kind/ns/name` is a plain delete (`404` counts as success). On `PodGroup/<ns>/<OwnerKind>/<owner>` the member pods are resolved from the cached store (pods whose ownerReferences chain reaches the owner — the same rule the graph uses) and deleted in parallel; if some fail, the error names them (`failed to delete: a, b (...)`) and carries the first failure's kind. A group with no members rejects with `notFound`.
- Manifests may contain Secret data: the backend never logs them.

## Events (`listen`)

| Event | Payload | Notes |
|---|---|---|
| `connection_state` | `"connected" \| "degraded" \| "disconnected"` | `connected` is emitted after `connect` succeeds and again whenever a namespace session starts; `disconnected` on `disconnect` and before a re-`connect` tears down the old session |
| `connection_error` | `AppError` | Per-kind failures: message is `"<Kind>: <reason>"`. `forbidden`/`notFound` per kind ⇒ the kind is dropped, call `denied_kinds` to mark its chip. A transient error is reported once per kind until it recovers. A fatal `auth` error (expired/invalid credentials) is reported once and followed by `disconnected`; the user must reconnect. |
| `graph_snapshot` | `Graph` | Full replace. Arrives after every kind finished its initial list, and again after recovery from `degraded`. |
| `graph_delta` | `GraphDelta` | Apply `addedNodes`/`updatedNodes` (full node objects) / `removedNodes` (ids) / `addedEdges` / `removedEdges` (ids). Only sent when non-empty. |
| `object_events` | `ObjectEvents` | Full list, newest first, for the node passed to `watch_events`. Ignore payloads whose `nodeId` is not the current selection. |

### Ordering rules the frontend must follow

- After `select_namespace`, clear the graph and ignore `graph_delta` until the next `graph_snapshot`. (The backend also drops events from the torn-down namespace session, but the rule keeps the UI correct regardless.)
- Treat every `graph_snapshot` as a full replace, not only the first one.
- `degraded` may arrive before any snapshot if a watcher cannot connect; a `connection_error` explains why.

## Node ids

- Namespaced: `Kind/<namespace>/<name>`; cluster-scoped: `PersistentVolume//<name>`.
- Collapsed pods: `PodGroup/<namespace>/<OwnerKind>/<ownerName>`. The owner is the *visible* owner — a Deployment whose single ReplicaSet is hidden yields `PodGroup/ns/Deployment/web`. During a rollout two ReplicaSets are visible, so the groups are `PodGroup/ns/ReplicaSet/<rs>` and the id changes back when the old ReplicaSet drains; expanded-group state does not survive that.
- `get_object` on a PodGroup returns `yaml: ""` and a summary of member counts; `watch_events` on a PodGroup is a no-op.

## Table

`list_rows({ kind })` returns `Table { kind, columns: TableColumn[], rows: TableRow[] }`:

- `TableColumn { key, label, numeric }` — one entry per kubectl-like column for that kind (see `graph::rows::columns`); `name` is always first.
- `TableRow { nodeId, status, cells: TableCell[] }` — `cells` align 1:1 with `columns`; rows are sorted by name.
- `TableCell { text, status: Status | null }` — `status` colours the cell (e.g. the Pod `status` cell, or a workload's `ready` cell) and is `null` for plain cells.
- `PodGroup` is not a table kind (`columns` is empty, `rows` is always empty) — `list_rows({ kind: "Pod" })` always lists individual pods; collapsing pods into groups is a graph-only concern.
- Requesting a kind the session could not watch (see `denied_kinds`) returns an empty table, not an error — the frontend shows the RBAC empty state itself.

## Timestamps

`K8sEvent.firstTimestamp` / `lastTimestamp` are RFC 3339 with a `Z` suffix (e.g. `2026-09-17T10:00:00Z`) or `null`.

## Settings file

The backend stores `extraKubeconfigs: string[]` in `settings.json` (tauri-plugin-store). The frontend uses the same file for its own keys; neither side overwrites the other's:

| Key | Type | Written by | Meaning |
|---|---|---|---|
| `extraKubeconfigs` | `string[]` | backend | Kubeconfig files added via "Add kubeconfig…" |
| `lastContext` | `string` | frontend | Context to reconnect on startup |
| `lastNamespace` | `Record<string, string>` | frontend | Last selected namespace, keyed by context name |
| `sidebarCollapsed` | `boolean` | frontend | Whether the Navigator is collapsed to its icon rail |

## Security notes

- `tauri.conf.json` ships with `"csp": null`; the frontend plan must set a policy once its asset needs are known.
- Secret YAML in `get_object` includes base64 `data` (accepted for the MVP).
