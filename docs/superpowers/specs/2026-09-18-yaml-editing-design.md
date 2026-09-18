# Wiring — YAML editing, create and delete

**Date:** 2026-09-18
**Status:** approved
**Builds on:** MVP (`2026-09-17-wiring-mvp-design.md`) and Navigator/tables (`2026-09-18-navigator-tables-design.md`), both merged.

## 1. Goal

Make Wiring a tool you can act from, not only look at: edit any watched object's YAML and save it back, create new objects from YAML (with per-kind templates), and delete objects — all with the safety nets Lens users expect (diff before save, optimistic-concurrency conflicts surfaced, server validation errors shown inline, confirmation before delete).

## 2. Non-goals

Editing CRDs or kinds outside the 15 watched ones; multi-object manifests (a document stream) in one create; `kubectl apply`-style three-way merge; schema-aware autocompletion; undo history across sessions.

## 3. User flows

**Edit.** Details panel → YAML tab → **Edit**. The read-only view becomes a CodeMirror editor pre-filled with the object's YAML (as shown today: `managedFields` stripped). **Save** opens a review step: a line diff of what will be sent, with **Apply** / **Back**. Apply sends the full document as a *replace* with the document's `metadata.resourceVersion`.
- Success → the editor returns to read-only mode showing the server's version; toast "Saved <Kind> <name>".
- 409 Conflict (the object changed since it was loaded) → banner inside the tab: "This object changed on the server while you were editing." with **Reload** (discard edits, load the latest) and **Overwrite** (send again using the latest `resourceVersion`, keeping every other field from the editor).
- 422 / 400 (server validation) → banner with the server message (multi-line, e.g. `spec.replicas: Invalid value: -1`), editor stays in edit mode.
- 403 → the usual forbidden toast; editor stays in edit mode.
- **Cancel** discards edits (confirm if the buffer differs from the original). While editing, incoming `object_events`/deltas do not touch the editor buffer.

**Create.** Header button **+ Create** (enabled when a namespace is selected). A modal with a kind picker (the 15 kinds; PersistentVolume is cluster-scoped and gets no namespace), a CodeMirror editor pre-filled with a minimal template for the chosen kind (namespace = current), and **Create** / **Cancel**. Server errors appear in a banner in the modal; on success the modal closes, the new object is selected (it arrives through the watch stream) and a toast confirms.

**Delete.** Details panel header → trash icon → confirmation dialog "Delete <Kind> <name>? This cannot be undone." with **Delete** / **Cancel**. For a `PodGroup` the dialog says "Delete N pods of <owner>?" and deletes every member pod (the controller will recreate them — the dialog says so). Success is reflected by the watch stream (node disappears, selection clears); a toast confirms. Also available from the table via the row's Delete key? No — keyboard delete is too easy to hit; only the explicit button.

## 4. Backend

Three commands (all go through the live `Session`'s client; all errors are `AppError`):

| Command | Args | Returns | Semantics |
|---|---|---|---|
| `update_object` | `{ nodeId, yaml, force: bool }` | `ObjectDetails` (fresh YAML/summary) | Parse YAML → the manifest's `kind`/`metadata.name`/`metadata.namespace` must match `nodeId` (else `invalid`). `force=false`: send as-is (server enforces `resourceVersion`). `force=true`: read the current object, copy its `resourceVersion` into the manifest, then replace. Uses `Api<DynamicObject>` for the kind's `ApiResource` with `fieldValidation=Strict`. |
| `create_object` | `{ namespace, yaml }` | `NodeId` | Parse YAML; `kind` must be one of the watched kinds (else `invalid`); namespace = manifest's `metadata.namespace` if set, else `namespace` arg (ignored for PersistentVolume). `fieldValidation=Strict`. |
| `delete_object` | `{ nodeId }` | `null` | Delete by kind/name/namespace. For `PodGroup/<ns>/<OwnerKind>/<owner>`: resolve member pods from the store (pods whose owner chain reaches `<owner>`, i.e. the same rule the graph uses) and delete each; partial failure → `AppError` naming the pods that failed. |

Error kinds — `ErrorKind` gains `conflict` (HTTP 409) and `invalid` (HTTP 400/422; message = the server's `message`, which already lists the bad fields). Both are added to the IPC contract and the TS enum list.

Pure, unit-tested pieces: `manifest::parse(yaml) -> Manifest { kind, name, namespace, body: serde_json::Value }` (YAML → JSON value, required fields, kind whitelist), `manifest::matches(manifest, node_id)`, `graph::build::group_members(store, group_id) -> Vec<ObjectKey>`. Network paths are covered by the smoke test (edit a ConfigMap, create + delete a ConfigMap, delete pods of a group, conflict on stale resourceVersion).

## 5. Frontend

- **Editor**: `@uiw/react-codemirror` + `@codemirror/lang-yaml`, dark theme built from the n8n tokens (`bg-panel` background, `text` foreground, keyword/string colours from the shiki `vesper` theme for consistency). Tab inserts two spaces; line numbers on; no minimap.
- **Diff**: `diff` (`diffLines`) rendered as a unified view with added/removed line colouring (`status-ok`/`status-err` tints), plus "N lines changed"; if nothing changed, Save is a no-op with a toast.
- **Templates** (`features/editor/templates.ts`): one minimal, valid manifest per kind with `metadata.name: my-<kind>` and `namespace: <current>`; Pod/Deployment/StatefulSet/DaemonSet/Job/CronJob use `registry.k8s.io/pause:3.9`; Service selects `app: my-app`; Ingress routes `/` to `my-service:80`; PVC 1Gi RWO; HPA targets `Deployment/my-deployment`; ConfigMap/Secret with one key; ServiceAccount plain; PV hostPath 1Gi.
- **State**: `editor: { mode: "view" | "edit" | "review", buffer: string, original: string, error: { kind, message } | null, saving: boolean }` inside `details` (reset when the selection changes); `createDialog: { open, kind, buffer, error, submitting }`; `deleteDialog: { open, nodeId }`.
- **Store actions**: `startEdit()`, `setBuffer(text)`, `reviewEdit()`, `applyEdit(force)`, `cancelEdit()`, `reloadEdit()`; `openCreate(kind?)`, `setCreateKind(kind)`, `setCreateBuffer(text)`, `submitCreate()`, `closeCreate()`; `requestDelete(nodeId)`, `confirmDelete()`, `cancelDelete()`.
- While `details.editor.mode !== "view"`, `select()` of another node asks for confirmation if the buffer is dirty (browser `confirm` is not available in Tauri webviews reliably — use the same in-app dialog component as delete).
- Keyboard: ⌘/Ctrl+S in edit mode = Save (review); Esc in review = Back, in edit = Cancel (with dirty check).

## 6. Security / safety

- `fieldValidation=Strict` so typos in field names are rejected by the server rather than silently dropped.
- Never log manifests (they may contain Secret data). Error banners show the server message only.
- Delete requires an explicit confirmation; PodGroup deletion lists the count.

## 7. Testing

- Rust: `manifest` parse/match/whitelist errors; `group_members` on the `podgroup` fixture (7 pods) and after expansion; error mapping 409 → `conflict`, 422/400 → `invalid` (via `from_status`); smoke test extended.
- Frontend: store editor state machine (start/edit/review/apply success/conflict/invalid/cancel/reload), create dialog (template per kind, namespace substitution, submit success/error), delete flow (confirm, PodGroup wording), YamlTab rendering in each mode, ⌘S/Esc handling, `select()` dirty guard.
- Live check on the demo cluster: edit `web-config` (add a key) → graph badge updates; create a ConfigMap from template → appears in graph/table; delete it; delete the `workers` PodGroup → pods recreated; provoke a conflict (`kubectl annotate` while editing) → Overwrite path.

## 8. Decisions log

| Decision | Chosen | Alternatives |
|---|---|---|
| Write strategy | Full replace with `resourceVersion`; Overwrite = re-read RV then replace | Server-side apply (field manager); JSON merge patch |
| Editor | CodeMirror 6 via `@uiw/react-codemirror` | Monaco (≈3 MB, heavy in WebView) |
| Diff | `diff` `diffLines`, unified view | Side-by-side; no diff |
| Create scope | Single object, watched kinds only | Multi-document manifests |
| Delete on PodGroup | Delete all member pods | Disabled for groups |

## 9. Deviations recorded during implementation

- **403 while saving** shows the server message as a banner in the tab *in addition to* the forbidden toast, so the reason stays visible after the toast fades.
- **Create defaults** to the kind of the table currently open (Deployment from the graph), since creating from a kind's table usually means "one more of these".
- **PodGroup delete toast** names the count: "Deleted 7 pods of Deployment workers"; the group node keeps its id (it is keyed by the visible owner), so the selection survives the recreation.
- **Overwrite** replaces the whole object from the editor, so fields changed on the server meanwhile (e.g. an annotation added by `kubectl`) are dropped — that is what the banner warns about; *Reload* is the merge-by-hand path.
- The **Save without `metadata.resourceVersion`** case is rejected as `invalid` by the backend rather than sent as an unconditional overwrite.
- **Every way out of a dirty editor asks first**: besides Cancel and a selection change, `discardDialog.pendingDeselect` (Escape-to-deselect), `pendingNamespace` (a namespace switch) and the select after a successful Create wait for the confirmation; a session reset (disconnect, reconnect, a dropped connection) cannot ask and toasts "Unsaved edits to … were discarded" instead.
- **A freshly created object is selected before it exists in the graph**: `get_object` may still answer `notFound` (not toasted); `applyDelta` fetches the details once the watch adds the node.
