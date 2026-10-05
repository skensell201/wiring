# Wiring — Workload actions: scale, restart, rollback

**Date:** 2026-10-05
**Status:** draft
**Builds on:** MVP, Navigator/tables, YAML editing and Pod logs (all released in v0.2.0).

## 1. Goal

The everyday rollout operations without hand-editing YAML or opening a terminal: **Scale** a Deployment or StatefulSet, **Restart** and **Rollback** a Deployment, StatefulSet or DaemonSet. Actions are reachable from an **Actions** menu (details panel header, right-click on graph nodes and table rows), revisions are browsed in a new **History** tab, and a running rollout is visible on the node until it finishes or gets stuck.

## 2. Non-goals

Pause/resume, `kubectl rollout status --watch`-style blocking, editing HPA min/max, bulk actions on several objects, keyboard shortcuts for the actions, rollback of ReplicaSets or other kinds, watching ControllerRevisions as a graph kind.

## 3. User flows

- **Actions menu.** The details panel header gets an **Actions ▾** button next to the trash icon; right-clicking a graph node or a table row selects that object and opens the same menu at the pointer. Items: **Scale…** (Deployment, StatefulSet), **Restart** and **Rollback…** (Deployment, StatefulSet, DaemonSet), a separator, **Delete…** (every kind, same confirmation as the trash icon). Kinds without rollout actions show only Delete. ↑/↓ move, Enter activates, Esc closes; focus starts on the first item.
- **Scale.** A dialog with a number field prefilled with `spec.replicas`, −/+ buttons and **Apply**. Range 0 … 10 000. When the graph has a `scales` edge from a HorizontalPodAutoscaler to the object, a warning sits above the field: *Managed by HPA `web-hpa` (min 2, max 10) — it will override this value.* Min/max come from `get_object` on the HPA when the dialog opens; if that fails the warning shows the name only. Apply stays enabled.
- **Restart.** A confirmation: *Restart Deployment web? Its pods are replaced according to the rollout strategy.*
- **Rollback… / History tab.** Deployment, StatefulSet and DaemonSet get a **History** tab after Logs. It lists revisions newest first: number, `current` marker, age, images, change-cause. Selecting a revision shows a `DiffView` of the current pod template against it and a **Rollback to N** button. **Rollback…** in the menu opens the History tab. Rollback asks for confirmation: *Roll web back to revision 3?* The current revision has no Rollback button.
- **Feedback.** Success: an info toast (*Scaled web to 5*, *Restarted web*, *Rolled web back to revision 3*). Failure: an error toast with the server's message. While a rollout runs the node shows a `rolling N/M` badge and a warning status; a Deployment whose rollout exceeded its progress deadline turns red, and Overview shows the condition's reason and message.
- **No permission to read history.** The History tab says *No permission to read revision history (replicasets)* for a Deployment and *(controllerrevisions)* for a StatefulSet or DaemonSet. Scale and Restart are unaffected.

## 4. Backend

### Commands

| Command | Args | Returns |
|---|---|---|
| `scale_object` | `{ nodeId, replicas }` | `ObjectDetails` |
| `restart_object` | `{ nodeId }` | `ObjectDetails` |
| `rollout_history` | `{ nodeId }` | `Revision[]`, newest first |
| `rollback_object` | `{ nodeId, revision }` | `ObjectDetails` |

`Revision = { revision: number, current: boolean, createdAt: string, changeCause: string | null, images: string[], template: string }`, where `template` is the revision's pod template as YAML (for Deployments without the `pod-template-hash` label, so the diff shows only real changes).

### Validation (before any API call)

- `scale_object`: kind is Deployment or StatefulSet; `replicas` is an integer in 0 … 10 000. Otherwise `invalid`.
- `restart_object`, `rollout_history`, `rollback_object`: kind is Deployment, StatefulSet or DaemonSet. PodGroup and every other kind reject with `invalid`.
- `restart_object` and `rollback_object` on a Deployment with `spec.paused: true` reject with `invalid` ("deployment is paused"), as kubectl does.
- `rollback_object` to the current revision rejects with `invalid` ("already at revision N"); an unknown revision rejects with `notFound`.

### Writes

- **Scale:** `PATCH` on the `/scale` subresource with `{"spec":{"replicas":N}}` (merge patch), the same as `kubectl scale`.
- **Restart:** merge patch `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] = <now, RFC 3339>`, the same as `kubectl rollout restart`.
- **Rollback, Deployment:** the selected ReplicaSet's `spec.template`, minus the `pod-template-hash` label, replaces `spec.template` with a JSON patch (`replace /spec/template`), the same result as `kubectl rollout undo`.
- **Rollback, StatefulSet / DaemonSet:** the selected ControllerRevision's `data` is applied as a strategic merge patch, the same as `kubectl rollout undo`.
- On success the returned object goes through the existing `store_saved` path and the graph is rebuilt at once, so a `graph_delta` and fresh `ObjectDetails` arrive before the watch echo — the same path `update_object` uses.

### History (`session/rollout.rs`)

- **Deployment:** ReplicaSets from the cached store whose ownerReference uid is the Deployment's uid. The revision number is the `deployment.kubernetes.io/revision` annotation; ReplicaSets without it are skipped. `current` is the revision named by the Deployment's own `deployment.kubernetes.io/revision` annotation (the highest when that is missing), so right after a rollout no entry may be current until the new ReplicaSet is cached. No API call; when the ReplicaSet watch is denied, `forbidden`.
- **StatefulSet / DaemonSet:** `list` ControllerRevisions in the namespace with the workload's `spec.selector.matchLabels` as label selector, kept only when an ownerReference uid matches the workload. The number is `.revision`. `current` is `status.updateRevision` for a StatefulSet and the highest revision for a DaemonSet. A 403 rejects with `forbidden`.
- `changeCause` is the `kubernetes.io/change-cause` annotation; `images` are the containers' images in order.
- Revision parsing and patch building are pure functions over typed objects, so they are unit-tested without a cluster.

### Status (`graph/status.rs`)

- Deployment: rolling while `status.observedGeneration < metadata.generation` or `updatedReplicas < spec.replicas`; badge `rolling updated/desired`, status Warn. `Progressing=False` (ProgressDeadlineExceeded) stays Err as today, and Overview gains the condition's reason and message.
- StatefulSet: rolling while `observedGeneration < generation` or `updatedReplicas < replicas`.
- DaemonSet: rolling while `observedGeneration < generation` or `updatedNumberScheduled < desiredNumberScheduled`.
- The `rolling` badge comes after the ready/desired badge and before the image badge.

### Contract

`docs/ipc-contract.md` gets the four commands, the `Revision` shape and the validation rules above; `src/shared/ipc/` gets the matching types and command wrappers.

## 5. Frontend

- `src/features/actions/`: `ActionsMenu` (items per kind, keyboard handling, rendered as a popover from the header button or at the pointer from a context menu), `ScaleDialog`, `RestartDialog`, `RollbackDialog` (a plain confirmation; the diff is already on screen in the History tab where a rollback starts).
- Right-click: `ResourceNode` / `Canvas` and `TableView` call a store action that selects the object and opens the menu at the pointer. The native context menu is suppressed only on nodes and rows.
- `src/features/details/HistoryTab.tsx`: calls `rollout_history` when shown, and again when a `graph_delta` updates the selected workload, at most once per second. Diff uses the existing `features/editor/DiffView`.
- Store (`src/app/store`): `scaleObject`, `restartObject`, `rollbackObject` and the open-dialog/menu state, following the `requestDelete` / `confirmDelete` pattern. Toasts use the existing `Toasts` component.
- HPA lookup: the incoming `scales` edge to the selected node in the current graph.

## 6. Testing

- **Rust unit (`rollout.rs`, `write.rs`, `status.rs`):** kind and range validation, paused Deployment, patch bodies for each action, revision lists for Deployment (from fixture ReplicaSets, hash label stripped, unannotated RS skipped) and StatefulSet/DaemonSet (owner filtering, `current`), `rolling` badge and status for each kind.
- **IPC contract tests (`src-tauri/tests/`):** argument names and payload shapes of the four commands.
- **Smoke test (live cluster):** scale `web` 3 → 2, restart it, wait for the new ReplicaSet, roll back to the previous revision, check the template matches.
- **Vitest:** menu items per kind; scale dialog with and without HPA; history list, diff, rollback, `forbidden`; right-click on a graph node and on a table row selects the object and opens the menu.

## 7. Decisions log

- Rollback covers Deployment, StatefulSet and DaemonSet, not Deployment only.
- Scaling an HPA-managed workload warns but is allowed.
- Actions live in an Actions menu (header + context menus); revisions in a History tab.
- Feedback is a toast plus a `rolling N/M` badge driven by the watched status, not a modal.
- History is fetched on demand (`rollout_history`), not by watching ControllerRevisions.
- Mechanics mirror kubectl (`/scale`, `restartedAt` annotation, `rollout undo` semantics) so results match what users expect from the CLI.
