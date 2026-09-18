# YAML Editing, Create and Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit any watched object's YAML with diff review and conflict handling, create objects from per-kind templates, delete objects (incl. all pods of a PodGroup) — backed by three new backend commands.

**Architecture:** Backend: a pure `manifest` module (YAML → validated `Manifest`), `graph::build::group_members`, and `Session::{update_object, create_object, delete_object}` using `Api<DynamicObject>` with `fieldValidation=Strict`; two new `ErrorKind`s (`conflict`, `invalid`). Frontend: an `editor` state machine inside `details`, `createDialog`/`deleteDialog` state, a CodeMirror-based `YamlEditor`, `DiffView`, `CreateDialog`, `ConfirmDialog`, and the YamlTab/DetailsPanel/Header wiring.

**Tech Stack:** unchanged + `@uiw/react-codemirror` 4.25, `@codemirror/lang-yaml` 6.1, `@uiw/codemirror-themes` 4.25, `diff` 9 (+ `@types/diff`).

**Spec:** `docs/superpowers/specs/2026-09-18-yaml-editing-design.md`. Base: `master` @ `d7eafb4`.

---

## File structure

```
src-tauri/src/manifest.rs                 Manifest { kind, name, namespace, body }, parse(), matches()
src-tauri/src/graph/build.rs              + group_members(store, group_id)
src-tauri/src/error.rs                    + ErrorKind::{Conflict, Invalid}; from_status maps 409/400/422
src-tauri/src/session/mod.rs              + update_object / create_object / delete_object (+ ApiResource per Kind)
src-tauri/src/commands.rs                 + three commands
src-tauri/tests/smoke.rs                  + edit/create/delete/conflict steps
src/shared/ipc/{types,commands}.ts        + ErrorKind values, commands
src/app/store.ts                          + editor / createDialog / deleteDialog state + actions
src/features/editor/theme.ts              CodeMirror theme from tokens
src/features/editor/YamlEditor.tsx        controlled CodeMirror wrapper
src/features/editor/DiffView.tsx          unified diff of two strings
src/features/editor/templates.ts          per-kind YAML templates
src/features/editor/CreateDialog.tsx      kind picker + editor + Create
src/features/details/YamlTab.tsx          view / edit / review modes + banners
src/features/details/DetailsPanel.tsx     + delete button
src/shared/ui/ConfirmDialog.tsx           generic confirm (delete, discard edits)
src/features/cluster/Header.tsx           + "+ Create" button
docs/ipc-contract.md                      + commands, error kinds
```

---

### Task 1: Backend — manifest parsing, error kinds, group members

**Files:** create `src-tauri/src/manifest.rs`; modify `error.rs`, `lib.rs` (`pub mod manifest;`), `graph/build.rs`, `src/shared/ipc/fixtures/app_error.json`? (no — keep), `docs/ipc-contract.md`.

- [ ] **Tests first** (`manifest.rs`): `parse` accepts a Deployment YAML → `kind == Kind::Deployment`, `name == "web"`, `namespace == Some("shop")`, `body["spec"]["replicas"] == 3`; rejects missing `kind`/`metadata.name` (`ErrorKind::Invalid`, message names the field); rejects an unwatched kind (`Node`) with message "kind Node is not supported"; rejects a multi-document stream ("one object per manifest"); `matches(&m, "Deployment/shop/web")` true, false for a different name/namespace/kind (returns `Err(Invalid)` with a clear message from `ensure_matches`). `error.rs`: `AppError::from_status(409, ..)` → `Conflict`, `422` and `400` → `Invalid`; serde values `"conflict"`/`"invalid"`. `build.rs`: `group_members(&store, "PodGroup/g/Deployment/api")` on the `podgroup` fixture returns the 7 `Pod/g/api-new-*` keys; unknown group → empty.
- [ ] **Implement**:
  ```rust
  pub struct Manifest { pub kind: Kind, pub name: String, pub namespace: Option<String>, pub body: serde_json::Value }
  pub fn parse(yaml: &str) -> AppResult<Manifest>          // serde_yaml_ng → Value; exactly one document; kind/name required; Kind::parse whitelist
  pub fn ensure_matches(m: &Manifest, node_id: &str) -> AppResult<()>  // kind/name/namespace vs parse_node_id
  ```
  `ErrorKind` gets `Conflict`, `Invalid` (camelCase serde). `from_status`: 409 → Conflict, 400 | 422 → Invalid. `group_members`: reuse the owner-edge logic — pods whose `ownerReferences` chain (Pod → RS → Deployment, or Pod → STS/DS/Job) ends at `<OwnerKind>/<owner>` in the group's namespace; return `Vec<ObjectKey>` sorted by name.
- [ ] `docs/ipc-contract.md`: ErrorKind list += `conflict`, `invalid`; `src/shared/ipc/types.ts` `ERROR_KINDS` += both (update `fixtures.test.ts` expectation) — do the TS edit here so the contract test stays in sync.
- [ ] Verify `cargo test`, clippy `-D warnings`, fmt; `pnpm test` (types). Commit: `Add manifest parsing, conflict/invalid error kinds and PodGroup member resolution`.

---

### Task 2: Backend — update / create / delete

**Files:** modify `src-tauri/src/session/mod.rs`, `src-tauri/src/commands.rs`, `src-tauri/tests/smoke.rs`, `docs/ipc-contract.md`.

- [ ] `session/mod.rs`:
  - `fn api_resource(kind: Kind) -> ApiResource` via `ApiResource::erase::<K>(&())` per kind (macro over the 15 types); `fn dynamic_api(&self, kind, ns: Option<&str>) -> Api<DynamicObject>` (`namespaced_with` / `all_with`).
  - `pub async fn update_object(&self, node_id: &str, yaml: &str, force: bool) -> AppResult<ObjectDetails>`: `manifest::parse` → `ensure_matches` → `DynamicObject` from `body` (`serde_json::from_value`) → if `force`, `api.get(name)` and set `metadata.resource_version` from it → `api.replace(name, &PostParams { field_validation: Some(ValidationDirective::Strict), ..Default::default() }, &obj)` → on success return `self.get_object(node_id)` **after** upserting the returned object into the store (so YAML is fresh even before the watch echo). Errors via `AppError::from(&kube::Error)` (409/422 now map correctly). If `field_validation` is not a `PostParams` field in kube 4.2, check `~/.cargo/registry/src/*/kube-core-4.2.0/src/params.rs` (it is `PostParams { dry_run, field_manager, field_validation }` since 0.85) and adapt.
  - `pub async fn create_object(&self, namespace: &str, yaml: &str) -> AppResult<NodeId>`: parse; ns = manifest.namespace or arg (None for PV); ensure `metadata.namespace` in the body equals ns for namespaced kinds (set it if absent); `api.create(&pp, &obj)`; return `node_id(kind, ns, name)`.
  - `pub async fn delete_object(&self, node_id: &str) -> AppResult<()>`: `parse_node_id`; PodGroup → `group_members(&store, id)` then delete each pod (`DeleteParams::default()`), collecting failures into one `Internal` error "failed to delete: a, b"; otherwise a single delete. 404 → treat as success (already gone).
- [ ] `commands.rs`: `update_object(state, node_id, yaml, force)`, `create_object(state, namespace, yaml)`, `delete_object(state, node_id)` via `session_mut`; register.
- [ ] `tests/smoke.rs` (live, `#[ignore]`): after the existing assertions — (1) `update_object("ConfigMap/wiring-smoke/web-cfg", <yaml with an extra key>, false)` → details YAML contains the key; (2) same call again with the *old* YAML (stale resourceVersion) → `Err(kind == Conflict)`; then with `force=true` → Ok; (3) `create_object("wiring-smoke", <ConfigMap smoke-created>)` → returns `ConfigMap/wiring-smoke/smoke-created`, then wait for it in the accumulated graph; (4) `delete_object` it → wait until gone; (5) `update_object` with a bogus field (`spec: {}` on a ConfigMap? use `data: 1`) → `Err(Invalid)`. Run it: `WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored --nocapture` (cluster is up).
- [ ] `docs/ipc-contract.md`: three command rows + semantics (force, Strict validation, PodGroup delete).
- [ ] Verify `cargo test`, smoke live, clippy, fmt. Commit: `Add update, create and delete commands`.

---

### Task 3: Frontend — editor state machine and commands

**Files:** modify `src/shared/ipc/commands.ts`, `src/app/store.ts` (+test), `src/app/useGlobalKeys.ts` (+test).

- [ ] `commands`: `updateObject(nodeId, yaml, force)`, `createObject(namespace, yaml)`, `deleteObject(nodeId)`.
- [ ] Store types:
  ```ts
  export type EditorMode = "view" | "edit" | "review";
  export interface EditorState { mode: EditorMode; buffer: string; original: string; error: AppError | null; saving: boolean }
  // Details gains: editor: EditorState  (initialised to view/""/"" when details load; original = data.yaml)
  createDialog: { open: boolean; kind: Kind; buffer: string; error: AppError | null; submitting: boolean }
  deleteDialog: { open: boolean; nodeId: NodeId | null }
  discardDialog: { open: boolean; pendingSelect: NodeId | null }   // "Discard edits?" when selecting another node while dirty
  ```
  Actions: `startEdit()` (mode edit, buffer = original), `setBuffer(text)`, `reviewEdit()` (if buffer === original → toast info "No changes" and stay), `backToEdit()`, `applyEdit(force = false)` (saving → `updateObject` → on success: details.data = result, original = result.yaml, mode view, toast "Saved <Kind> <name>"; on `conflict`/`invalid`/other error: `error` set, mode stays edit (from review → edit)), `cancelEdit()` (dirty → open discardDialog with `pendingSelect: null`; else mode view), `reloadEdit()` (refetch `getObject`, original = buffer = fresh yaml, mode edit, error null), `confirmDiscard()` / `cancelDiscard()`; `select(id)` when `details.editor.mode !== "view"` and dirty → open discardDialog with `pendingSelect = id` instead of switching; `openCreate(kind?)` (kind default "Deployment", buffer = template(kind, namespace)), `setCreateKind(kind)` (re-templates only if buffer is untouched or equals the previous template), `setCreateBuffer`, `submitCreate()` (→ `createObject` → close, toast "Created <Kind> <name>", `select(nodeId)` after the node appears — just call `select`, `get_object` works from the store once the watch delivers it; if it fails with NotFound, ignore), `closeCreate()`; `requestDelete(nodeId)`, `confirmDelete()` (→ `deleteObject`; toast "Deleted …"), `cancelDelete()`.
  - `object_events`/`applyDelta`/`applySnapshot` never touch `details.editor` (they only update `details.events` / clear the selection when the node is gone — if the edited node is deleted underneath, keep the editor open and set `error = { kind: "notFound", message: "This object was deleted on the server." }`).
- [ ] `useGlobalKeys`: ⌘/Ctrl+S → `reviewEdit()` when mode is edit (`preventDefault`); Esc: review → `backToEdit`, edit → `cancelEdit`, dialogs → close (priority: discard > delete > create > editor > selection).
- [ ] Tests (store): the state machine transitions above incl. conflict → error kind `conflict`, `applyEdit(true)` after conflict calls `update_object` with `force: true`, invalid error keeps edit mode, reload replaces original+buffer, dirty select opens discardDialog and `confirmDiscard` performs the pending select, create dialog templating + namespace substitution + submit success/error, delete confirm calls `delete_object` and closes; `useGlobalKeys` tests for ⌘S/Esc.
- [ ] Commit: `Add editor, create and delete state to the store`.

---

### Task 4: Frontend — editor UI

**Files:** create `src/features/editor/{theme.ts,YamlEditor.tsx,DiffView.tsx,templates.ts,CreateDialog.tsx}` (+tests), `src/shared/ui/ConfirmDialog.tsx`; modify `src/features/details/{YamlTab,DetailsPanel}.tsx` (+tests), `src/features/cluster/Header.tsx`, `src/App.tsx`, `package.json`.

- [ ] `pnpm add @uiw/react-codemirror @codemirror/lang-yaml @uiw/codemirror-themes diff` and `pnpm add -D @types/diff`. CSP: CodeMirror injects styles via `<style>` — `style-src 'unsafe-inline'` already allows it.
- [ ] `theme.ts`: `createTheme({ theme: "dark", settings: { background: "#1b1728", foreground: "#d1cece", caret: "#fd8925", selection: "#2c2834", lineHighlight: "#1a1624", gutterBackground: "#1b1728", gutterForeground: "#9d9797" }, styles: [ { tag: t.keyword, color: "#fd8925" }, { tag: t.propertyName, color: "#7dd3fc" }, { tag: t.string, color: "#99ffe4" }, { tag: t.number, color: "#fd8925" }, { tag: t.comment, color: "#8b8b8b" } ] })` (vesper-ish colours; `t` from `@lezer/highlight`, available transitively — add as a dependency if the import fails).
- [ ] `YamlEditor.tsx`: `<CodeMirror value onChange height="100%" theme extensions={[yaml()]} basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, tabSize: 2 }} indentWithTab />` in a `selectable` wrapper; `readOnly` prop; `aria-label`. Tests: renders the value, `onChange` fires on input (`@uiw/react-codemirror` renders a real editor in jsdom — if typing is awkward, test `onChange` via the exposed `EditorView` dispatch, or mock the component in tests of parents; keep one real test that it mounts with content).
- [ ] `DiffView.tsx`: `diffLines(original, next)` → `<pre>` lines with `data-diff="add|del|same"` and tint classes; header "N lines changed" (added + removed). Test: known strings → correct counts and markers.
- [ ] `templates.ts`: `template(kind: Kind, namespace: string | null): string` (see spec §5); test: every watched kind yields YAML that `parse`s (use `js-yaml`? no — assert it contains `kind: <Kind>`, `name: my-`, and `namespace: <ns>` for namespaced kinds; and does NOT contain `namespace` for PersistentVolume).
- [ ] `ConfirmDialog.tsx`: `{ open, title, body, confirmLabel, danger?, onConfirm, onCancel }`, `role="alertdialog"`, Escape → cancel, autofocus on Cancel for danger dialogs.
- [ ] `YamlTab.tsx`: view mode (as today + **Edit** button; `Copy`); edit mode (`YamlEditor` + toolbar: Save (⌘S), Cancel; error banner from `details.editor.error` with the message; for `conflict` the banner shows **Reload** and **Overwrite** buttons; for `notFound` "deleted on the server" with **Reload**); review mode (`DiffView` + **Apply** / **Back**; `saving` disables buttons). PodGroup: no Edit button.
- [ ] `DetailsPanel.tsx`: trash icon button in the header (title "Delete") → `requestDelete(selectedId)`; renders `<ConfirmDialog>` for `deleteDialog` (PodGroup wording "Delete N pods of <owner>? The controller will recreate them." using `group.count`), and for `discardDialog` ("Discard your edits?").
- [ ] `CreateDialog.tsx`: modal (`role="dialog"`), kind `<select>` (watched kinds, labelled via `KIND_META`), `YamlEditor`, error banner, **Create** / **Cancel**; mounted in `App.tsx`; **+ Create** button in `Header` (disabled without a namespace) → `openCreate()`.
- [ ] Tests: YamlTab in each mode (buttons present, banner variants, Overwrite calls `applyEdit(true)`), DetailsPanel delete button → dialog wording for a Pod and a PodGroup → confirm calls `confirmDelete`, CreateDialog template switch + submit, Header Create button enabled/disabled.
- [ ] Verify `pnpm typecheck && pnpm test && pnpm build` (CodeMirror chunks should lazy-load: make `YamlEditor` a `React.lazy` import inside YamlTab/CreateDialog with a "Loading editor…" fallback so the main bundle stays small — verify the build output lists a separate chunk).
- [ ] Commit: `Add YAML editing, create and delete UI`.

---

### Task 5: Live check, polish, docs

- [ ] `pnpm tauri dev` on `docker-desktop` / `shop`: edit `web-config` (add `NEW_KEY: "1"`) → Save → diff shows +1 → Apply → badge "3 keys" on the graph; `kubectl -n shop annotate configmap web-config demo=1` while editing another change → Save → conflict banner → Overwrite → success; introduce `data: 1` → Invalid banner with the server message; **+ Create** → ConfigMap template → Create → appears in the graph and table, gets selected; delete it via the trash button; delete the `workers` PodGroup → 7 pods recreated (watch the table); Esc/⌘S behave; `wiring-viewer` context: Save → forbidden toast, editor keeps edits.
- [ ] Fix findings with tests; README paragraph ("Editing"); spec deviations recorded.
- [ ] Commit: `Polish editing after live run`.

## Done criteria

`cargo test` green + smoke test passes live with the new steps; `pnpm test` green; live walkthrough done; merged to `master`.
