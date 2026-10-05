# Wiring — Why is it red: problem reasons and the path to the root cause

**Date:** 2026-10-05
**Status:** approved
**Builds on:** MVP, Navigator/tables, YAML editing, Pod logs, Workload actions (branch `feat/workload-actions`).

## 1. Goal

When a node is yellow or red, say why — without opening pods one by one. Every unhealthy node carries a short **problem**: a reason, an optional message from Kubernetes (kubelet, scheduler, controller) and, when the fault lies elsewhere, a pointer to the neighbour to blame. Selecting the node shows a **Problem** block at the top of Overview with the root cause and the chain that leads to it, and the chain is highlighted on the graph.

## 2. Non-goals

A namespace-wide Events watch, probe-failure analysis beyond what Events say, suggestions or fixes ("try a different tag"), problems for healthy nodes, problems in tables, a problem badge on the node itself, notifications.

## 3. User flows

- Select the red `bad-image` Deployment. Overview starts with a red **Problem** block: **ImagePullBackOff** — `bad-image-7c9…-x2k: container web: Back-off pulling image "nginx:this-tag-does-not-exist"`, and below it the path `Deployment bad-image → Pod bad-image-7c9…-x2k` with each step clickable. On the graph the nodes and edges of that path are highlighted in the status colour.
- Select a Service with no ready endpoints: **No ready endpoints**, path `Service api → Deployment api → Pod group (3): 3 of 3 pods: CrashLoopBackOff`, message `api-…: container api: last exit code 1 (Error)`.
- Select an Ingress whose backend Service is missing: **Backend not found** — `service "shop-web" does not exist`. No path.
- Select a pending PVC: its own status only says Pending, so the block shows the latest Warning event of the PVC instead (`ProvisioningFailed — storageclass "fast" not found`), marked *from Events*. With no Warning event the block shows **Pending** alone.
- Yellow nodes get the same block in the warning colour. Healthy nodes have no block.
- The block and the highlight update live with the graph; when the problem goes away the block disappears.

## 4. Backend

### Model (`graph/model.rs`)

`Node` gains `problem: Option<Problem>` (`#[serde(skip_serializing_if = "Option::is_none")]`), set only when the node's status is Warn or Err:

```rust
pub struct Problem {
    pub reason: String,
    pub message: Option<String>,
    pub cause: Option<NodeId>,
}
```

### Own reasons (`graph/status.rs`)

A pure `problem(obj: &Object, status: Status) -> Option<Problem>` next to `describe`, with `cause: None`:

| Kind | reason | message |
|---|---|---|
| Pod (container waiting/terminated with a reason) | that reason (`ImagePullBackOff`, `ErrImagePull`, `CrashLoopBackOff`, `OOMKilled`, `Error`, `CreateContainerConfigError`…) — the same reason `describe` picks | `container <name>: <state message>`; for CrashLoopBackOff/Error from `lastState.terminated`: `container <name>: last exit code N (<reason>)` |
| Pod Pending with `PodScheduled=False` | `Unschedulable` (or the condition's reason) | the condition's message |
| Pod Failed / other Pending | the phase | `status.message` if any |
| Deployment with `Progressing=False` or `ReplicaFailure=True` | the condition's reason (`ProgressDeadlineExceeded`, `FailedCreate`) | the condition's message |
| Deployment / StatefulSet / DaemonSet / ReplicaSet not all ready | `N of M not ready` | none |
| Job failed | the `Failed` condition's reason (`BackoffLimitExceeded`, `DeadlineExceeded`) | its message |
| CronJob suspended | `Suspended` | none |
| Service without ready endpoints | `No ready endpoints`, or `Selects no pods` when the selector matches nothing | none |
| Ingress with a missing backend | `Backend not found` | `service "<name>" does not exist` |
| PVC Pending | `Pending` | none |
| HPA limited / unable to scale | the reason of `ScalingActive=False` or `AbleToScale=False`, else `ScalingLimited` | its message |

Messages are trimmed to 300 characters. Secret data never appears in them (they come from status fields only).

### Cause links (`graph/build.rs`)

A pass after `hide_single_replicasets` and `collapse_pod_groups`, over the final nodes and edges, so ids are the visible ones:
- Workloads (`N of M not ready`, or a Deployment condition reason) point `cause` at the worst-status target of their outgoing `owns` edges.
- Services point at the worst-status target of `selects`; Ingresses with a problem other than *Backend not found* at the worst target of `routes`.
- Only targets with status Warn or Err qualify; ties go to the smallest node id, so the choice is stable across rebuilds.
- **PodGroup**: its problem is computed from its member pods: reason `K of N pods: <reason>` for the most common reason among the worst-status members (ties → alphabetical), message `<pod name>: <that pod's message>` from the first such member by name; no `cause`.

### Contract

`docs/ipc-contract.md` documents `GraphNode.problem` and its fields; a node JSON fixture with a problem is added to the IPC fixture tests.

## 5. Frontend

- `src/shared/ipc/types.ts`: `Problem` and the optional `problem` on `GraphNode`, with the guard updated.
- `src/features/details/problemPath.ts`: pure `problemPath(id, nodes)` → the chain of node ids following `cause`, stopping at a node without `cause`, a missing node, a repeat, or 8 steps.
- `src/features/details/ProblemBlock.tsx`, rendered at the top of `OverviewTab` for a selected node whose status is Warn or Err: reason and message of the **root** (last node of the path), the path as clickable chips (`select`), coloured with the status tokens. When the root has no message and the selected object has a Warning event in `details.events`, the newest one is shown (`reason — message`, labelled *from Events*).
- Graph: when the selected node has a problem path, its nodes and the edges between consecutive steps are highlighted in the status colour (in `toFlow.ts`, alongside the existing selection highlight), and the rest of the selection highlight stays as it is.

## 6. Testing

- **Rust unit:** `problem()` for each row of the table on fixtures (new `problems.yaml`), message trimming, cause links after RS hiding and pod-group collapse (Deployment → PodGroup), tie-breaking, PodGroup reason aggregation, no problem on healthy nodes, serialisation skips `problem: None`.
- **IPC fixtures:** a node with a problem round-trips through `isGraphNode`.
- **Vitest:** `problemPath` (chain, missing node, cycle, depth cap); `ProblemBlock` (root reason/message, chips select, Events fallback, warning vs error colour, hidden for healthy nodes); graph highlight of the path.
- **Smoke test:** the fixture's broken image pod gives its Deployment a `cause` chain ending in `ImagePullBackOff`/`ErrImagePull`.

## 7. Decisions log

- The explanation lives in an Overview **Problem** block plus a highlighted path on the graph, not on the node.
- Reasons come from object status; the selected object's Warning events are the fallback. No namespace-wide Events watch.
- Problems are computed in the backend during the graph build and travel with `graph_snapshot` / `graph_delta`; no new command.
- `cause` is resolved on the final graph (after RS hiding and pod-group collapse), so it always names a visible node.
