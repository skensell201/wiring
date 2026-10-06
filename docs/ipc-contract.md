# IPC contract — backend ↔ frontend

The JSON fixtures in `src/shared/ipc/fixtures/` are the authoritative payload shapes; a Rust test (`src-tauri/tests/ipc_fixtures.rs`) fails when a Rust type drifts from them. This page records what the fixtures alone do not say.

## Enum string values

| Type | Values |
|---|---|
| `Kind` | `Deployment`, `StatefulSet`, `DaemonSet`, `ReplicaSet`, `Job`, `CronJob`, `Pod`, `Service`, `Ingress`, `ConfigMap`, `Secret`, `PersistentVolumeClaim`, `PersistentVolume`, `ServiceAccount`, `HorizontalPodAutoscaler`, `NetworkPolicy`, `Role`, `RoleBinding`, `ClusterRole`, `ClusterRoleBinding`, `Node`, `PodGroup`, `Custom` (a custom resource: graph nodes and custom tables only; `ClusterRole`, `ClusterRoleBinding` and `Node` are cluster-scoped: ids `Kind//name`) |
| `Status` | `ok`, `warn`, `err`, `unknown` |
| `Relation` | `owns`, `selects`, `routes`, `mounts`, `envFrom`, `claims`, `binds`, `usesSA`, `scales`, `applies`, `allows`, `grants`, `subject`, `runsOn` |
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
| `select_namespaces` | `{ namespaces: string[] \| null, expandedGroups: string[] }` | `null` — `null` watches all namespaces (refused with `invalid` when `ConnectInfo.canListNamespaces` is false); a list watches those (trimmed, deduplicated, each a DNS-1123 label, at most 20; an empty or longer list rejects with `invalid`: "pick up to 20 namespaces, or All namespaces"). The graph arrives via events. |
| `set_expanded_groups` | `{ expandedGroups: string[] }` | `null` |
| `get_object` | `{ nodeId }` | `ObjectDetails` (`summary` is an ordered `[string, string][]`) |
| `watch_events` | `{ nodeId: string \| null }` | `null` — `null` stops the current watcher |
| `denied_kinds` | — | `Kind[]` — kinds the session could not watch (RBAC 403 / API group missing) |
| `partial_kinds` | — | `Kind[]` — kinds watched in some namespaces but forbidden in others (or forbidden cluster-wide and watched per namespace instead) |
| `list_rows` | `{ kind, includeHelmStorage? }` | `Table` — kubectl-like columns/rows for `kind`, computed from the cached store. Helm storage Secrets (`type: helm.sh/release.v1`) are left out unless `includeHelmStorage` is true |
| `custom_kinds` | — | `CustomKind[]` — discovery, cached per session (see [Custom resources](#custom-resources)) |
| `refresh_custom_kinds` | — | `CustomKind[]` — runs discovery again and replaces the cache |
| `list_custom` | `{ resource: ResourceRef }` | `CustomTable`; the table then stays live through `custom_table` events |
| `stop_custom` | — | `null` — stops the live custom table; no `custom_table` event follows |
| `helm_releases` | — | `HelmRelease[]` (see [Helm](#helm)) |
| `helm_release` | `{ namespace, name }` | `HelmReleaseDetails` — `notFound` when no revision of the release decodes |
| `update_object` | `{ nodeId, yaml, force: boolean }` | `ObjectDetails` — fresh YAML/summary of the saved object (see [Writes](#writes)) |
| `create_object` | `{ namespace, yaml }` | `NodeId` of the created object; it reaches the graph through the watch |
| `delete_object` | `{ nodeId }` | `null` — a PodGroup id deletes every member pod |
| `scale_object` | `{ nodeId, replicas }` | `ObjectDetails` (see [Rollout actions](#rollout-actions)) |
| `restart_object` | `{ nodeId }` | `ObjectDetails` |
| `rollout_history` | `{ nodeId }` | `Revision[]`, newest first |
| `rollback_object` | `{ nodeId, revision }` | `ObjectDetails` |

`ConnectInfo.namespaces` may be **empty** when the user cannot list namespaces (namespace-scoped RBAC); offer a free-text namespace input in that case. If the kubeconfig context has a default namespace it is included. `ConnectInfo.canListNamespaces` is `true` only when `namespaces` came from listing them; when it is `false` (listing was forbidden, so the list is just the context namespace) do not offer *All namespaces* — the backend refuses it.

### Writes

- `update_object` parses `yaml` as exactly one document; its `kind`, `metadata.name` and `metadata.namespace` must match `nodeId`, otherwise the promise rejects with `invalid` before anything is sent (rename/move are not supported through editing). Names and namespaces must be DNS-1123 subdomains (also `invalid`). The object is replaced (`PUT`) with `fieldValidation=Strict`, so unknown or duplicate fields reject with `invalid` and the server's message lists them. With `force: false` the manifest must carry a non-empty `metadata.resourceVersion` (else `invalid`: "metadata.resourceVersion is missing; reload the object or use Overwrite") and the server enforces it: a stale one rejects with `conflict`. With `force: true` the current `resourceVersion` and `uid` are fetched and copied in first, overwriting whatever changed in between (this also works after the object was deleted and recreated). On success the saved object is placed in the store and the graph is rebuilt immediately (a `graph_delta` follows), so the returned details and node badges are fresh before the watch echo arrives; an object the session does not watch (another namespace) is not cached.
- `create_object` uses the manifest's own `metadata.namespace` when set, else `namespace`; both are ignored for cluster-scoped kinds (PersistentVolume). A missing `apiVersion` is filled in from the kind. Creating an existing object rejects with `conflict`; a kind outside the watched list with `invalid`.
- `delete_object` on `Kind/ns/name` is a plain delete (`404` counts as success). On `PodGroup/<ns>/<OwnerKind>/<owner>` the member pods are resolved from the cached store (pods whose ownerReferences chain reaches the owner — the same rule the graph uses) and deleted in parallel; if some fail, the error names them (`failed to delete: a, b (...)`) and carries the first failure's kind. A group with no members rejects with `notFound`.
- Manifests may contain Secret data: the backend never logs them.

### Rollout actions

- `scale_object` takes a Deployment or StatefulSet and an integer `replicas` in 0 … 10 000; anything else is `invalid` before a request is sent. It patches the `/scale` subresource (as `kubectl scale`), then returns the object's fresh details.
- `restart_object`, `rollout_history` and `rollback_object` take a Deployment, StatefulSet or DaemonSet (PodGroup and every other kind: `invalid`). Restart sets `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` (as `kubectl rollout restart`). Restart and rollback on a paused Deployment are `invalid` ("deployment is paused; resume it first").
- `Revision = { revision: number, current: boolean, createdAt: string | null, changeCause: string | null, images: string[], template: string }`; `template` is the pod template as YAML. Deployment revisions come from its ReplicaSets in the cached store (`deployment.kubernetes.io/revision`; ReplicaSets without it are skipped, `pod-template-hash` is left out of `template`), the newest being current. StatefulSet/DaemonSet revisions are listed from ControllerRevisions (label selector = `matchLabels`, filtered by ownerReference uid); `current` is a StatefulSet's `status.updateRevision`, else the newest. A role without `list controllerrevisions` gets `forbidden`. Fixture: `revision.json`.
- `rollback_object` to the current revision is `invalid` ("already at revision N"); an unknown one is `notFound`. Deployments get their old template back with `$patch: replace` (as `kubectl rollout undo`); StatefulSets/DaemonSets get the revision's `data` as a strategic merge patch.
- Like `update_object`, every successful action stores the server's object and rebuilds the graph at once, so the returned details and the `graph_delta` arrive before the watch echo.

## Events (`listen`)

| Event | Payload | Notes |
|---|---|---|
| `connection_state` | `"connected" \| "degraded" \| "disconnected"` | `connected` is emitted after `connect` succeeds and again whenever a namespace session starts; `disconnected` on `disconnect` and before a re-`connect` tears down the old session |
| `connection_error` | `AppError` | Per-kind failures: message is `"<Kind>: <reason>"`. `forbidden`/`notFound` per kind ⇒ the kind is dropped, call `denied_kinds` to mark its chip. A transient error is reported once per kind until it recovers. A fatal `auth` error (expired/invalid credentials) is reported once and followed by `disconnected`; the user must reconnect. |
| `graph_snapshot` | `Graph` | Full replace. Arrives after every kind finished its initial list, and again after recovery from `degraded`. When the graph has more than 1 500 nodes the snapshot is `{ nodes: [], edges: [], tooLarge: { nodes, kinds: [{ kind, count, worst }] } }` (a PodGroup counts its pods under `Pod`); every change of `tooLarge` (entering, leaving, or new counts) arrives as a new snapshot, never as a delta. |
| `graph_delta` | `GraphDelta` | Apply `addedNodes`/`updatedNodes` (full node objects) / `removedNodes` (ids) / `addedEdges` / `removedEdges` (ids). Only sent when non-empty. |
| `object_events` | `ObjectEvents` | Full list, newest first, for the node passed to `watch_events`. Ignore payloads whose `nodeId` is not the current selection. |
| `forwards_changed` | `Forward[]` | Every running forward, ordered by id, after each start, stop and status change (see [Port-forward](#port-forward)). Empty after a disconnect. |
| `custom_table` | `CustomTable` | The full rows of the live custom table after a change (debounced); see [Custom resources](#custom-resources) |
| `metrics_updated` | `{ state: "pending" \| "available" \| "unavailable" \| "forbidden" }` | After each metrics-server sample of the selected namespace (every 15 s), and once when the Metrics API turns out to be missing (404 → `unavailable`) or forbidden (403 → `forbidden`), after which polling stops for that namespace session. Three failed polls in a row before any sample (a registered but unhealthy metrics-server) also send `unavailable`, with the Overview note "metrics-server not responding"; polling continues and a sample sends `available`. A sample older than 60 s adds "(stale)" to the Overview usage rows. Refetch the open Pod / Deployment / StatefulSet / DaemonSet table and the selected details. Usage badges arrive as an ordinary `graph_delta`. |

### Ordering rules the frontend must follow

- After `select_namespaces`, clear the graph and ignore `graph_delta` until the next `graph_snapshot`. (The backend also drops events from the torn-down namespace session, but the rule keeps the UI correct regardless.)
- Treat every `graph_snapshot` as a full replace, not only the first one.
- A snapshot whose namespaced nodes fall outside the current selection belongs to the previous one and is ignored.
- `degraded` may arrive before any snapshot if a watcher cannot connect; a `connection_error` explains why.

## Node ids

- Namespaced: `Kind/<namespace>/<name>`; cluster-scoped: `PersistentVolume//<name>` (likewise `ClusterRole//`, `ClusterRoleBinding//`, `Node//`).
- Collapsed pods: `PodGroup/<namespace>/<OwnerKind>/<ownerName>`. The owner is the *visible* owner — a Deployment whose single ReplicaSet is hidden yields `PodGroup/ns/Deployment/web`. During a rollout two ReplicaSets are visible, so the groups are `PodGroup/ns/ReplicaSet/<rs>` and the id changes back when the old ReplicaSet drains; expanded-group state does not survive that.
- Custom resources: `Custom/<group>/<version>/<kind>/<namespace>/<name>`. The namespace segment is empty for cluster-scoped kinds, and the group segment is empty for the core group. Example: `Custom/cert-manager.io/v1/Certificate/shop/web-tls`. A CR owner node on the graph takes its namespace from the child object it owns. Ids are resolved against discovery, so a cluster-scoped kind ignores the namespace segment. A malformed custom id rejects with `notFound`.
- `get_object` on a PodGroup returns `yaml: ""` and a summary of member counts; `watch_events` on a PodGroup is a no-op.

## Problems

A node whose `status` is `warn` or `err` may carry `problem: { reason, message, cause }`; healthy nodes have no `problem` key at all.
- `reason` is short (`ImagePullBackOff`, `2 of 3 not ready`, `No ready endpoints`, `Backend not found`, `1 of 7 pods: CrashLoopBackOff`). `message` is the Kubernetes text behind it (kubelet, scheduler or controller), at most 300 characters, or `null`.
- `cause` is the id of a node in the same graph to blame next (a workload's worst-status owned child, a Service's worst-status selected pod or pod group), or `null` at the root. It is resolved after ReplicaSet hiding and pod-group collapse, so it always names a visible node. Follow it to the root, stopping at a missing node, a repeat or 8 steps.
- A PodGroup's problem summarises its members: `K of N pods: <reason>` with the message of the first such pod by name, prefixed with the pod name.
- Problems change with the objects, so they arrive through the usual `graph_snapshot` / `graph_delta` (`updatedNodes`).

## Policies, RBAC and Nodes

- `applies`: NetworkPolicy to each selected Pod (or PodGroup). `allows`: a Pod (or PodGroup) that matches an ingress peer (`podSelector` / `namespaceSelector`) to the NetworkPolicy that admits it. Peers that are `ipBlock`s or empty draw nothing. Egress rules appear in Overview text only, with no edges.
- `grants`: RoleBinding / ClusterRoleBinding to its Role / ClusterRole. `subject`: binding to each ServiceAccount subject. `runsOn`: Pod (or PodGroup) to its Node.
- ClusterRole, ClusterRoleBinding and Node appear only when connected to the scope (bound to a ServiceAccount or Role in it, or running one of its pods).
- A Pod selected by any NetworkPolicy in its namespace carries the `policy` badge.
- Node status: `ok` when Ready, `err` when the Ready condition is not `True`, `warn` when Ready but `MemoryPressure`, `DiskPressure`, `PIDPressure` or `NetworkUnavailable` is `True` (the condition is added to the badges). A Pending/Unknown pod on a red node gets the node as its problem `cause`.
- `namespaceSelector` peers are matched on the `kubernetes.io/metadata.name` label only (Namespaces are not watched); other namespace labels match nothing, though the rule text still lists them.
- Fixture: `graph_extras.json`.

## Table

`list_rows({ kind })` returns `Table { kind, columns: TableColumn[], rows: TableRow[] }`:

- `TableColumn { key, label, numeric }` — one entry per kubectl-like column for that kind (see `graph::rows::columns`); `name` is always first.
- `TableRow { nodeId, status, cells: TableCell[] }` — `cells` align 1:1 with `columns`; rows are sorted by name.
- With several namespaces selected `list_rows` returns a leading `namespace` column (`—` for cluster-scoped kinds) and rows sorted by namespace, then name.
- `TableCell { text, status: Status | null }` — `status` colours the cell (e.g. the Pod `status` cell, or a workload's `ready` cell) and is `null` for plain cells.
- `PodGroup` is not a table kind (`columns` is empty, `rows` is always empty) — `list_rows({ kind: "Pod" })` always lists individual pods; collapsing pods into groups is a graph-only concern.
- Requesting a kind the session could not watch (see `denied_kinds`) returns an empty table, not an error — the frontend shows the RBAC empty state itself.

## Custom resources

`custom_kinds` runs discovery on its first call of a session, then answers from a cache;
`refresh_custom_kinds` runs it again. A `CustomKind` is `{ resource: ResourceRef, columns: PrinterColumn[] }`.
`ResourceRef` is `{ group, version, kind, plural, namespaced }` (`group` is empty for the core group), and
`PrinterColumn` is `{ name, jsonPath, type }`: the CRD's priority-0 `additionalPrinterColumns` for the served
version. Without permission to list CRDs, `columns` is empty.

`list_custom { resource }` returns a `CustomTable` `{ resource, table, error }`. Its `table.kind` is `"Custom"`, and
its columns are Name, Namespace (multi-namespace scopes only, first), the printer columns (keys `c0`, `c1`, …)
and Age. Unsupported JSONPath shows `—`. The table stays live: a debounced `custom_table` event with the full
rows follows every change, until `stop_custom`, another `list_custom`, or a namespace switch. The frontend
keeps a `custom_table` event only when it is for the table on screen (compare `resource` group/version/kind).
`error` is null except on the last `custom_table` event of a table whose watch ended for good —
`No access to <Kind> (RBAC)`, `<Kind> is no longer served`, or the server's message — whose rows are then
empty; the frontend shows it in place of the rows. A kind that is not served (or cannot be listed) rejects
with `notFound`; `list_custom` without a selected namespace rejects with `invalid`.

`get_object`, `update_object`, `delete_object` and `create_object` accept custom ids and custom manifests (a
manifest goes down the built-in path only when its `kind` is a built-in `Kind` and its `apiVersion` is in that
kind's API group (any version, e.g. `autoscaling/v1` for a HorizontalPodAutoscaler), or missing; anything else — e.g. a Knative `serving.knative.dev/v1` `Service` — is resolved through
discovery by its `apiVersion` and `kind`). They
behave as for built-in kinds (strict field validation, `resourceVersion` conflicts, Overwrite), except that the
objects are read from the server on demand: they are never in the graph store. A request runs against the cluster its kind
was resolved in: when the connection changes during discovery it rejects with `conflict` ("the cluster
connection changed; try again"). A custom resource that owns a
watched object appears on the graph as a node of kind `Custom` with status `unknown` and an `owns` edge.

## Helm

`helm_releases` returns `HelmRelease[]` (latest revision per release in the scope):
`{ name, namespace, chart, appVersion, revision, status, health, updated }`. `chart` is `name-version`;
`status` is Helm's own (`deployed`, `failed`, `pending-upgrade`, …); `health` maps it to a `Status`
(`deployed` ok, `pending-*` and `uninstalling` warn, `failed` err, others unknown). `helm_release { namespace, name }`
returns `HelmReleaseDetails` `{ release, description, firstDeployed, lastDeployed, values, notes, history, resources }`:
`values` is the user-supplied values as YAML (empty when none), `history` lists every stored revision newest
first (`{ revision, chart, appVersion, status, health, updated, description }`), and `resources` are the node
ids of the release's objects in the store (Helm's `meta.helm.sh/release-*` annotations, or
`app.kubernetes.io/managed-by: Helm` + `app.kubernetes.io/instance`). Both read the watched Secrets: there is no
event, so the frontend re-reads them when the graph changes. Release values can hold credentials and are
never logged.

## Metrics

- Source: `metrics.k8s.io/v1beta1` `PodMetrics` in the selected namespaces (keyed `namespace/name`; forbidden namespaces skipped), polled every 15 s while the namespace session lives.
- Tables: Pod, Deployment, StatefulSet and DaemonSet gain numeric `cpu` (`CPU`) and `memory` (`Memory`) columns. Values are `kubectl top` style — CPU always in millicores (`120m`), memory always in whole MiB (`64Mi`) — so the leading number sorts correctly; `—` without a sample. Workloads sum the pods they own.
- `get_object` summary for those kinds ends with `CPU usage` and `Memory usage` rows (`120m / req 100m / lim 500m (24%)`: requests and limits summed over containers, a total omitted when any container lacks it; the percentage is of the limit, else of the request), or a single `Usage` row: `waiting for the first metrics sample`, `Metrics API not available (install metrics-server)`, `No access to pod metrics (RBAC)` or `no sample yet`.
- Graph: a pod or workload at ≥ 80 % of a CPU or memory limit gets a last badge `mem 92%` / `cpu 85%` (the higher; memory on a tie). Usage never changes `status`.

## Timestamps

`K8sEvent.firstTimestamp` / `lastTimestamp` are RFC 3339 with a `Z` suffix (e.g. `2026-09-17T10:00:00Z`) or `null`.

## Settings file

The backend stores `extraKubeconfigs: string[]` in `settings.json` (tauri-plugin-store). The frontend uses the same file for its own keys; neither side overwrites the other's:

| Key | Type | Written by | Meaning |
|---|---|---|---|
| `extraKubeconfigs` | `string[]` | backend | Kubeconfig files added via "Add kubeconfig…" |
| `lastContext` | `string` | frontend | Context to reconnect on startup |
| `lastNamespace` | `Record<string, string>` | frontend | Last selected namespace, keyed by context name |
| `lastScope` | `Record<string, "all" \| string[]>` | frontend | Last selected scope per context; supersedes `lastNamespace`, which is still read once for migration |
| `sidebarCollapsed` | `boolean` | frontend | Whether the Navigator is collapsed to its icon rail |

## Security notes

- `tauri.conf.json` ships with `"csp": null`; the frontend plan must set a policy once its asset needs are known.
- Secret YAML in `get_object` includes base64 `data` (accepted for the MVP).

## Logs

Container logs stream through a Tauri `Channel` passed to `start_logs`, not through events.

### Commands

| Command | Args | Returns |
|---|---|---|
| `start_logs` | `{ nodeId, container: string \| null, previous: bool, timestamps: bool, onMessage: Channel<LogMessage> }` | `sessionId: number` |
| `stop_logs` | `{ sessionId }` | `null` |
| `exec_pods` | `{ nodeId }` | `ExecPod[]` — running pods of a Pod / Deployment / StatefulSet / DaemonSet / Job / PodGroup with their regular containers; other kinds `invalid` |
| `start_exec` | `{ nodeId, pod, container, cols, rows, onMessage: Channel<ExecMessage> }` | `number` session id; see [Exec](#exec) |
| `exec_input` | `{ sessionId, data }` | `null` — `data` is base64 keystrokes; not base64 → `invalid` |
| `exec_resize` | `{ sessionId, cols, rows }` | `null` |
| `stop_exec` | `{ sessionId }` | `null` — nothing reaches the channel afterwards |
| `save_text` | `{ path, text }` | `null` — writes a file chosen with the save dialog |

`nodeId` may be a `Pod`, `Deployment`, `StatefulSet`, `DaemonSet`, `Job`, `CronJob` or `PodGroup`; anything else is `invalid`. A selection that resolves to no container at all (an unknown `container`, a workload without pods) is `notFound`, so a session always has something to stream. Each `(pod, container)` the node stands for is one stream (`tail_lines=500`, `follow` unless `previous`). Pods that appear or disappear while streaming start/stop their streams, and a container that restarts gets a stream for its new run. At most 64 streams per session.

### `LogMessage` (tagged by `type`)

| `type` | fields |
|---|---|
| `lines` | `sessionId`, `lines: [{ pod, container, text }]` |
| `started` | `sessionId`, `pod`, `container` |
| `ended` | `sessionId`, `pod`, `container` |
| `error` | `sessionId`, `pod`, `container`, `message` |
| `truncated` | `sessionId`, `limit` |

`ended` means the stream is over, whether the server closed it or the session stopped it because its pod (or that run of its container) went away. Batches arrive at most every 50 ms or every 256 lines. After `stop_logs` nothing more is sent on that channel. Fixture: `log_message.json`.

## Exec

`start_exec` checks the request against the cached store (`pod` must be a running pod of `nodeId`, `container` one of its regular containers — otherwise `invalid` / `notFound`) and returns at once. The session then opens `sh -c "command -v bash >/dev/null && exec bash || exec sh"` with a TTY of `cols`x`rows` (each clamped to 1...1000) and pushes `ExecMessage`s (tagged by `type`) through the channel:

- `{ type: "output", sessionId, data }` — `data` is base64 of the raw TTY bytes, chunked as they arrive.
- `{ type: "ended", sessionId, code, message }` — the shell exited: `code` from the exit status (`0` on success, `null` when unknown); `message` is `"This container has no shell (distroless image?)"` when the image has no `sh`, the server's message for other failures, else `null`.
- `{ type: "error", sessionId, message }` — the connection could not be opened: `"No permission to exec into pods (pods/exec)"`, `"timed out connecting to the container"` (15 s), or the API error.

Input sent before the connection is up is queued. Sessions end with the namespace session (namespace switch, disconnect) like log sessions. Nothing typed or printed is logged. Fixtures: `exec_message.json`, `exec_pod.json`.

## Port-forward

### Commands

| Command | Args | Returns |
|---|---|---|
| `forward_ports` | `{ nodeId }` | `PortOption[]` — `{ port, label }`: container ports (TCP) of a Pod or a workload's template, `port → targetPort` of a Service |
| `suggest_local_port` | `{ port }` | `number` — `port` if ≥ 1024 and free on 127.0.0.1, else the first free port from 8080 |
| `start_forward` | `{ nodeId, remotePort, localPort }` | `Forward` — returns immediately with `status: active` and `pod: null`; the first pod resolution happens in the background and is reported through `forwards_changed` |
| `stop_forward` | `{ id }` | `null` — unknown ids are a no-op; the local port is released when the call returns |
| `open_forward` | `{ id }` | `null` — opens `http://127.0.0.1:<localPort>` in the default browser; unknown id is `notFound` |

`nodeId` may be a `Pod`, `Service`, `Deployment`, `StatefulSet` or `DaemonSet` (anything else, and PodGroups, are `invalid`). `localPort` below 1024 is `invalid`; a port already in use is `conflict` ("port N is already in use"). Forwards bind `127.0.0.1` only, survive `select_namespaces` and stop on `disconnect` / `connect`.

Each accepted local connection picks its pod at that moment: a Pod target itself (Running and Ready), otherwise the ready pod with the smallest name among those the Service's or workload's selector matches. For a Service, `remotePort` is a Service port mapped to its `targetPort` (a number, or a name looked up in the chosen pod's container ports). A connection that finds no pod is closed and sets the status. A selector with only `matchExpressions` is not supported (status `error`, "unsupported selector (matchExpressions)").

### `Forward`

`{ id, nodeId, targetLabel, remotePort, localPort, pod: string | null, status, message: string | null }`, `status` ∈ `active`, `noReadyPod`, `podGone` (a Pod target that no longer exists), `error` (with `message`: `forbidden (pods/portforward)` for RBAC, a kubelet stream error, `unsupported selector (matchExpressions)`, a timeout). Fixtures: `forward.json`, `port_option.json`.

## Updates

| Command | Args | Returns |
|---|---|---|
| `check_update` | — | `UpdateCheck { current, update: UpdateInfo \| null }`; `UpdateInfo = { version, date: string \| null (YYYY-MM-DD), notes: string \| null }`. Rejects `network` when the feed is unreachable or no published release has a `latest.json`. |
| `install_update` | — | Downloads, verifies and installs the update found by the last `check_update`, then relaunches — the promise never resolves on success. Rejects `notFound` without a prior offer, `network` / `internal` on download, signature or install failures. |

| Event | Payload | Notes |
|---|---|---|
| `update_progress` | `{ downloaded, total: number \| null }` | During `install_update`, at most every 256 KiB and for the last chunk. |
| `menu_check_updates` | `null` | **Check for Updates…** was chosen in the app menu. |
