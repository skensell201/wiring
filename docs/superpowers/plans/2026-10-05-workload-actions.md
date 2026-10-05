# Workload Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scale (Deployment, StatefulSet), Restart and Rollback (Deployment, StatefulSet, DaemonSet) from an **Actions** menu (details header and right-click on graph nodes / table rows), a **History** tab with revision diffs, and a `rolling N/M` badge while a rollout runs.

**Architecture:** A new pure module `session/rollout.rs` holds the kind checks, the patch bodies (kubectl semantics) and revision history: Deployment revisions come from the ReplicaSets already in the `Store`; StatefulSet/DaemonSet revisions from a one-off `list` of ControllerRevisions. Four Tauri commands wrap thin `impl Session` methods that patch through `Api<DynamicObject>` and push the result through the existing `store_saved` + rebuild path. `graph/status.rs` adds the rolling badge. The frontend gets a global `ActionsMenu`, `ActionDialogs`, a `HistoryTab`, and store state for the menu, the open dialog and a requested details tab.

**Tech Stack:** kube 4.2 (`Api::patch`, `Api::patch_scale`, `Patch::Merge` / `Patch::Strategic`, `ListParams::labels`), k8s-openapi 0.28 (`ControllerRevision`), serde_yaml_ng; React 19, zustand 5, `diff` (existing `DiffView`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-05-workload-actions-design.md`. **Branch:** `feat/workload-actions` (Task 1 creates it).

**Conventions (all tasks):** TDD. Rust tests: `cd src-tauri && rtk proxy cargo test`; frontend: `rtk proxy pnpm vitest run <path>` and `rtk proxy pnpm typecheck` (the `rtk proxy ` prefix returns raw output). Comments, tests and UI text in English. Every commit message ends with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

## File map

Backend (`src-tauri/`):
- Create `src/session/rollout.rs` — `Revision`, `HistoryEntry`, `check_scale`, `check_rollout_kind`, `check_not_paused`, `scale_patch`, `restart_patch`, `deployment_history`, `controller_history`, `pick_rollback`, `selector_string` (pure, unit-tested), plus `impl Session { scale_object, restart_object, rollout_history, rollback_object }`.
- Create `tests/fixtures/history.yaml` (Deployments + ReplicaSets with revision annotations), `tests/fixtures/rolling.yaml` (workloads mid-rollout).
- Modify `src/session/mod.rs` (`pub mod rollout`), `src/session/write.rs` (`pub(super)` on `resource_for`, `store_saved`, `kube_err`, `dynamic_api`), `src/commands.rs` (4 commands), `src/graph/status.rs` (rolling badge, Deployment condition message), `tests/ipc_fixtures.rs`, `tests/smoke.rs`, `tests/fixtures/smoke.yaml` (a StatefulSet).
- Docs: `docs/ipc-contract.md` (Rollout actions), `README.md` (Features).

Frontend (`src/`):
- Modify `shared/ipc/types.ts` (`Revision`, `isRevision`), `shared/ipc/commands.ts`, `shared/ipc/fixtures.test.ts`; create `shared/ipc/fixtures/revision.json`.
- Create `features/actions/actionKinds.ts` (kind sets, `actionsFor`, `kindOf`, `describeId`, `desiredReplicas`, `hpaFor`, `MAX_REPLICAS`), `features/actions/age.ts`, `features/actions/ActionsMenu.tsx`, `features/actions/ActionDialogs.tsx`, `features/details/HistoryTab.tsx`, and tests beside them.
- Modify `app/store.ts` (menu/dialog/tab state, `scaleObject`/`restartObject`/`rollbackObject`), `app/useGlobalKeys.ts` (Escape), `features/details/DetailsPanel.tsx` (Actions button, History tab, requested tab), `features/graph/Canvas.tsx` and `features/table/TableView.tsx` (right-click), `App.tsx` (mount menu + dialogs).
- Create `app/store.actions.test.ts`.

---

### Task 1: Branch

- [ ] **Step 1: Create the branch from an up-to-date master**

```bash
git switch master
git status --short          # expect: nothing (the plan file may show as untracked; leave it)
git switch -c feat/workload-actions
```

Expected: `Switched to a new branch 'feat/workload-actions'`.

---

### Task 2: Kind checks and patch bodies

**Files:**
- Create: `src-tauri/src/session/rollout.rs`
- Modify: `src-tauri/src/session/mod.rs:3-7`

- [ ] **Step 1: Register the module**

In `src-tauri/src/session/mod.rs`, after `pub mod reducer;` add:

```rust
pub mod rollout;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/session/rollout.rs`:

```rust
//! Rollout actions (spec 2026-10-05): which kinds take which action, the patch bodies
//! (kubectl semantics) and revision history. Everything above the `impl Session` block is pure.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::store::{Kind, Object};

/// Upper bound for a manual scale; anything larger is a typo, not an intent.
pub const MAX_REPLICAS: i64 = 10_000;
const RESTARTED_AT_ANNOTATION: &str = "kubectl.kubernetes.io/restartedAt";

/// One entry of a workload's rollout history, as the History tab shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub revision: i64,
    pub current: bool,
    pub created_at: Option<String>,
    pub change_cause: Option<String>,
    pub images: Vec<String>,
    /// The revision's pod template as YAML (Deployments: without `pod-template-hash`).
    pub template: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;

    #[test]
    fn scale_accepts_deployments_and_statefulsets_within_range() {
        assert!(check_scale(Kind::Deployment, 0).is_ok());
        assert!(check_scale(Kind::StatefulSet, MAX_REPLICAS).is_ok());
        for (kind, n) in [
            (Kind::Deployment, -1),
            (Kind::Deployment, MAX_REPLICAS + 1),
            (Kind::DaemonSet, 1),
            (Kind::ConfigMap, 1),
            (Kind::PodGroup, 1),
        ] {
            assert_eq!(check_scale(kind, n).unwrap_err().kind, ErrorKind::Invalid, "{kind:?} {n}");
        }
        assert_eq!(
            check_scale(Kind::Deployment, -1).unwrap_err().message,
            "replicas must be between 0 and 10000"
        );
        assert_eq!(check_scale(Kind::DaemonSet, 1).unwrap_err().message, "DaemonSet cannot be scaled");
    }

    #[test]
    fn only_rollout_kinds_restart_and_roll_back() {
        for kind in [Kind::Deployment, Kind::StatefulSet, Kind::DaemonSet] {
            assert!(check_rollout_kind(kind).is_ok(), "{kind:?}");
        }
        for kind in [Kind::ReplicaSet, Kind::Pod, Kind::Job, Kind::PodGroup] {
            let err = check_rollout_kind(kind).unwrap_err();
            assert_eq!(err.kind, ErrorKind::Invalid, "{kind:?}");
            assert_eq!(err.message, format!("{} has no rollout", kind.as_str()));
        }
    }

    #[test]
    fn a_paused_deployment_refuses_restart_and_rollback() {
        let store = Store::from_fixture("history").unwrap();
        let frozen = store.find(Kind::Deployment, Some("h"), "frozen").unwrap();
        let err = check_not_paused(frozen).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "deployment is paused; resume it first");
        assert!(check_not_paused(store.find(Kind::Deployment, Some("h"), "web").unwrap()).is_ok());
    }

    #[test]
    fn patch_bodies_match_kubectl() {
        assert_eq!(scale_patch(5), json!({ "spec": { "replicas": 5 } }));
        assert_eq!(
            restart_patch("2026-10-05T10:00:00Z"),
            json!({ "spec": { "template": { "metadata": { "annotations": {
                "kubectl.kubernetes.io/restartedAt": "2026-10-05T10:00:00Z"
            } } } } })
        );
    }
}
```

Create `src-tauri/tests/fixtures/history.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: h, uid: dep-web }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [ { name: web, image: "web:2" } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: frozen, namespace: h, uid: dep-frozen }
spec:
  paused: true
  selector: { matchLabels: { app: frozen } }
  template:
    metadata: { labels: { app: frozen } }
    spec: { containers: [ { name: frozen, image: "frozen:1" } ] }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-1111
  namespace: h
  uid: rs-1111
  creationTimestamp: "2026-10-01T10:00:00Z"
  annotations:
    deployment.kubernetes.io/revision: "1"
    kubernetes.io/change-cause: first release
  ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: web, uid: dep-web, controller: true } ]
spec:
  replicas: 0
  selector: { matchLabels: { app: web, pod-template-hash: "1111" } }
  template:
    metadata: { labels: { app: web, pod-template-hash: "1111" } }
    spec: { containers: [ { name: web, image: "web:1" } ] }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-2222
  namespace: h
  uid: rs-2222
  creationTimestamp: "2026-10-02T10:00:00Z"
  annotations:
    deployment.kubernetes.io/revision: "2"
  ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: web, uid: dep-web, controller: true } ]
spec:
  replicas: 2
  selector: { matchLabels: { app: web, pod-template-hash: "2222" } }
  template:
    metadata: { labels: { app: web, pod-template-hash: "2222" } }
    spec: { containers: [ { name: web, image: "web:2" } ] }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-legacy
  namespace: h
  uid: rs-legacy
  ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: web, uid: dep-web, controller: true } ]
spec:
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [ { name: web, image: "web:0" } ] }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: api-9999
  namespace: h
  uid: rs-9999
  annotations:
    deployment.kubernetes.io/revision: "9"
  ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: api, uid: dep-api, controller: true } ]
spec:
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec: { containers: [ { name: api, image: "api:9" } ] }
```

- [ ] **Step 3: Run the tests to make sure they fail**

Run: `cd src-tauri && rtk proxy cargo test --lib session::rollout`
Expected: compile errors `cannot find function check_scale` / `check_rollout_kind` / `check_not_paused` / `scale_patch` / `restart_patch`.

- [ ] **Step 4: Implement the checks and patches**

In `src-tauri/src/session/rollout.rs`, below the `Revision` struct (above `#[cfg(test)]`):

```rust
/// Scale applies to Deployments and StatefulSets, with 0 … `MAX_REPLICAS` replicas.
pub fn check_scale(kind: Kind, replicas: i64) -> AppResult<()> {
    if !matches!(kind, Kind::Deployment | Kind::StatefulSet) {
        return Err(AppError::new(ErrorKind::Invalid, format!("{} cannot be scaled", kind.as_str())));
    }
    if !(0..=MAX_REPLICAS).contains(&replicas) {
        return Err(AppError::new(
            ErrorKind::Invalid,
            format!("replicas must be between 0 and {MAX_REPLICAS}"),
        ));
    }
    Ok(())
}

/// Restart, history and rollback apply to the kinds with a rolling pod template.
pub fn check_rollout_kind(kind: Kind) -> AppResult<()> {
    if matches!(kind, Kind::Deployment | Kind::StatefulSet | Kind::DaemonSet) {
        Ok(())
    } else {
        Err(AppError::new(ErrorKind::Invalid, format!("{} has no rollout", kind.as_str())))
    }
}

/// kubectl refuses to restart or roll back a paused Deployment: nothing would roll out.
pub fn check_not_paused(obj: &Object) -> AppResult<()> {
    if let Object::Deployment(d) = obj {
        if d.spec.as_ref().and_then(|s| s.paused).unwrap_or(false) {
            return Err(AppError::new(ErrorKind::Invalid, "deployment is paused; resume it first"));
        }
    }
    Ok(())
}

/// Merge patch for the `/scale` subresource, as `kubectl scale` sends it.
pub fn scale_patch(replicas: i64) -> Value {
    json!({ "spec": { "replicas": replicas } })
}

/// Merge patch that changes the pod template and so starts a rollout, as `kubectl rollout restart`.
pub fn restart_patch(now: &str) -> Value {
    let mut annotations = Map::new();
    annotations.insert(RESTARTED_AT_ANNOTATION.into(), Value::String(now.into()));
    json!({ "spec": { "template": { "metadata": { "annotations": annotations } } } })
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `cd src-tauri && rtk proxy cargo test --lib session::rollout`
Expected: `test result: ok. 4 passed`. (A `dead_code` warning for `Revision` is fine until Task 3.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/session/mod.rs src-tauri/src/session/rollout.rs src-tauri/tests/fixtures/history.yaml
git commit -m "$(cat <<'EOF'
Add rollout kind checks and kubectl-style scale/restart patches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Revision history and rollback targets

**Files:**
- Modify: `src-tauri/src/session/rollout.rs`

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `src-tauri/src/session/rollout.rs`:

```rust
    use k8s_openapi::api::apps::v1::{ControllerRevision, Deployment};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;

    fn deployment(store: &Store, name: &str) -> Deployment {
        match store.find(Kind::Deployment, Some("h"), name) {
            Some(Object::Deployment(d)) => d.clone(),
            other => panic!("{other:?}"),
        }
    }

    fn controller_revision(name: &str, owner: &str, revision: i64, image: &str) -> ControllerRevision {
        serde_json::from_value(json!({
            "metadata": {
                "name": name, "namespace": "h", "creationTimestamp": "2026-10-03T10:00:00Z",
                "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "StatefulSet", "name": "db", "uid": owner, "controller": true }]
            },
            "revision": revision,
            "data": { "spec": { "template": {
                "$patch": "replace",
                "metadata": { "labels": { "app": "db" } },
                "spec": { "containers": [{ "name": "db", "image": image }] }
            } } }
        }))
        .unwrap()
    }

    fn numbers(entries: &[HistoryEntry]) -> Vec<(i64, bool)> {
        entries.iter().map(|e| (e.revision.revision, e.revision.current)).collect()
    }

    #[test]
    fn deployment_history_lists_owned_annotated_replicasets_newest_first() {
        let store = Store::from_fixture("history").unwrap();
        let entries = deployment_history(&store, &deployment(&store, "web"));
        // web-legacy has no revision annotation; api-9999 belongs to another Deployment.
        assert_eq!(numbers(&entries), vec![(2, true), (1, false)]);
        let first = &entries[1].revision;
        assert_eq!(first.images, vec!["web:1".to_string()]);
        assert_eq!(first.change_cause.as_deref(), Some("first release"));
        assert_eq!(first.created_at.as_deref(), Some("2026-10-01T10:00:00Z"));
        assert!(first.template.contains("image: web:1"), "{}", first.template);
        assert!(!first.template.contains("pod-template-hash"), "{}", first.template);
        assert_eq!(entries[0].revision.change_cause, None);
        let patch = &entries[1].rollback;
        assert_eq!(patch["spec"]["template"]["$patch"], "replace");
        assert_eq!(patch["spec"]["template"]["spec"]["containers"][0]["image"], "web:1");
        assert_eq!(patch["spec"]["template"]["metadata"]["labels"], json!({ "app": "web" }));
    }

    #[test]
    fn controller_history_filters_by_owner_and_marks_the_update_revision() {
        let list = vec![
            controller_revision("db-aaa", "sts-db", 1, "pg:16"),
            controller_revision("db-bbb", "sts-db", 2, "pg:17"),
            controller_revision("other-ccc", "sts-other", 5, "x:1"),
        ];
        let entries = controller_history("sts-db", Some("db-aaa"), &list);
        assert_eq!(numbers(&entries), vec![(2, false), (1, true)]);
        assert!(!entries[0].revision.template.contains("$patch"), "{}", entries[0].revision.template);
        assert!(entries[0].revision.template.contains("image: pg:17"), "{}", entries[0].revision.template);
        assert_eq!(entries[0].revision.images, vec!["pg:17".to_string()]);
        assert_eq!(entries[0].revision.created_at.as_deref(), Some("2026-10-03T10:00:00Z"));
        assert_eq!(entries[0].rollback, list[1].data.as_ref().unwrap().0, "the revision's data is the patch");
        // DaemonSets report no update revision, and a stale one is unknown: the newest is current.
        assert_eq!(numbers(&controller_history("sts-db", None, &list)), vec![(2, true), (1, false)]);
        assert_eq!(numbers(&controller_history("sts-db", Some("gone"), &list)), vec![(2, true), (1, false)]);
    }

    #[test]
    fn pick_rollback_refuses_the_current_and_unknown_revisions() {
        let store = Store::from_fixture("history").unwrap();
        let entries = deployment_history(&store, &deployment(&store, "web"));
        assert_eq!(pick_rollback(&entries, 1).unwrap(), &entries[1].rollback);
        let err = pick_rollback(&entries, 2).unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (ErrorKind::Invalid, "already at revision 2"));
        let err = pick_rollback(&entries, 7).unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (ErrorKind::NotFound, "revision 7 not found"));
    }

    #[test]
    fn selector_string_joins_match_labels() {
        let sel: LabelSelector = serde_json::from_value(json!({ "matchLabels": { "app": "db", "tier": "data" } })).unwrap();
        assert_eq!(selector_string(&sel), "app=db,tier=data");
        assert_eq!(selector_string(&LabelSelector::default()), "");
    }
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd src-tauri && rtk proxy cargo test --lib session::rollout`
Expected: compile errors `cannot find type HistoryEntry`, `cannot find function deployment_history` / `controller_history` / `pick_rollback` / `selector_string`.

- [ ] **Step 3: Implement history**

In `src-tauri/src/session/rollout.rs`, extend the imports at the top:

```rust
use k8s_openapi::api::apps::v1::{ControllerRevision, Deployment, ReplicaSet};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};

use crate::store::{Kind, Object, Store};
```

(replace the previous `use crate::store::{Kind, Object};`), add the constants next to `RESTARTED_AT_ANNOTATION`:

```rust
const REVISION_ANNOTATION: &str = "deployment.kubernetes.io/revision";
const CHANGE_CAUSE_ANNOTATION: &str = "kubernetes.io/change-cause";
const POD_TEMPLATE_HASH: &str = "pod-template-hash";
```

and add below `restart_patch`:

```rust
/// A revision plus the strategic merge patch that rolls the workload back to it.
#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub revision: Revision,
    pub rollback: Value,
}

fn owned_by(meta: &ObjectMeta, uid: &str) -> bool {
    meta.owner_references.as_ref().is_some_and(|refs| refs.iter().any(|r| r.uid == uid))
}

fn created_at(meta: &ObjectMeta) -> Option<String> {
    meta.creation_timestamp.as_ref().map(|t| t.0.to_string())
}

fn change_cause(meta: &ObjectMeta) -> Option<String> {
    meta.annotations.as_ref().and_then(|a| a.get(CHANGE_CAUSE_ANNOTATION)).cloned()
}

fn images_of(template: &Value) -> Vec<String> {
    template
        .pointer("/spec/containers")
        .and_then(Value::as_array)
        .map(|cs| cs.iter().filter_map(|c| c["image"].as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn to_yaml(value: &Value) -> String {
    serde_yaml_ng::to_string(value).unwrap_or_default()
}

/// A ReplicaSet with a revision annotation as a history entry. The `pod-template-hash` label is
/// the controller's own; leaving it out keeps diffs to real changes, and the controller re-adds it.
fn replicaset_entry(rs: &ReplicaSet) -> Option<HistoryEntry> {
    let revision = rs.metadata.annotations.as_ref()?.get(REVISION_ANNOTATION)?.parse::<i64>().ok()?;
    let mut template = serde_json::to_value(rs.spec.as_ref()?.template.as_ref()?).ok()?;
    if let Some(labels) = template.pointer_mut("/metadata/labels").and_then(Value::as_object_mut) {
        labels.remove(POD_TEMPLATE_HASH);
    }
    // `$patch: replace` swaps the whole template (like `kubectl rollout undo`) instead of merging
    // into it, so annotations and env entries added since that revision do not survive.
    let mut replace = template.clone();
    if let Some(t) = replace.as_object_mut() {
        t.insert("$patch".into(), Value::String("replace".into()));
    }
    Some(HistoryEntry {
        revision: Revision {
            revision,
            current: false,
            created_at: created_at(&rs.metadata),
            change_cause: change_cause(&rs.metadata),
            images: images_of(&template),
            template: to_yaml(&template),
        },
        rollback: json!({ "spec": { "template": replace } }),
    })
}

/// A Deployment's revisions, newest (= current) first, from the ReplicaSets it owns.
pub fn deployment_history(store: &Store, deployment: &Deployment) -> Vec<HistoryEntry> {
    let Some(uid) = deployment.metadata.uid.as_deref() else { return Vec::new() };
    let namespace = deployment.metadata.namespace.as_deref();
    let mut entries: Vec<HistoryEntry> = store
        .iter_kind(Kind::ReplicaSet)
        .filter_map(|o| match o {
            Object::ReplicaSet(rs) => Some(rs),
            _ => None,
        })
        .filter(|rs| rs.metadata.namespace.as_deref() == namespace && owned_by(&rs.metadata, uid))
        .filter_map(replicaset_entry)
        .collect();
    entries.sort_by(|a, b| b.revision.revision.cmp(&a.revision.revision));
    if let Some(first) = entries.first_mut() {
        first.revision.current = true;
    }
    entries
}

fn controller_entry(cr: &ControllerRevision, current: bool) -> Option<HistoryEntry> {
    let data = cr.data.as_ref()?.0.clone();
    let mut template = data.pointer("/spec/template").cloned().unwrap_or(Value::Null);
    if let Some(t) = template.as_object_mut() {
        t.remove("$patch");
    }
    Some(HistoryEntry {
        revision: Revision {
            revision: cr.revision,
            current,
            created_at: created_at(&cr.metadata),
            change_cause: change_cause(&cr.metadata),
            images: images_of(&template),
            template: to_yaml(&template),
        },
        rollback: data,
    })
}

/// A StatefulSet's or DaemonSet's revisions, newest first, from the ControllerRevisions owned by
/// `owner_uid`. `update_revision` (a StatefulSet's `status.updateRevision`) names the current one;
/// without it, or when it names none of them, the newest is current. The revision's `data` is
/// already the strategic merge patch kubectl applies to roll back.
pub fn controller_history(owner_uid: &str, update_revision: Option<&str>, list: &[ControllerRevision]) -> Vec<HistoryEntry> {
    let mut owned: Vec<&ControllerRevision> = list.iter().filter(|cr| owned_by(&cr.metadata, owner_uid)).collect();
    owned.sort_by(|a, b| b.revision.cmp(&a.revision));
    let current = update_revision
        .and_then(|name| owned.iter().position(|cr| cr.metadata.name.as_deref() == Some(name)))
        .unwrap_or(0);
    owned
        .iter()
        .enumerate()
        .filter_map(|(i, cr)| controller_entry(cr, i == current))
        .collect()
}

/// The rollback patch for `revision`: unknown revisions are `notFound`, the current one `invalid`.
pub fn pick_rollback(entries: &[HistoryEntry], revision: i64) -> AppResult<&Value> {
    let entry = entries
        .iter()
        .find(|e| e.revision.revision == revision)
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("revision {revision} not found")))?;
    if entry.revision.current {
        return Err(AppError::new(ErrorKind::Invalid, format!("already at revision {revision}")));
    }
    Ok(&entry.rollback)
}

/// `matchLabels` as a list label selector; `matchExpressions` are left to the owner filter.
pub fn selector_string(selector: &LabelSelector) -> String {
    selector
        .match_labels
        .as_ref()
        .map(|l| l.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","))
        .unwrap_or_default()
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && rtk proxy cargo test --lib session::rollout`
Expected: `test result: ok. 8 passed`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/session/rollout.rs
git commit -m "$(cat <<'EOF'
Build rollout history from ReplicaSets and ControllerRevisions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Session methods, Tauri commands, IPC contract

**Files:**
- Modify: `src-tauri/src/session/write.rs:53,109,130,146`, `src-tauri/src/session/rollout.rs`, `src-tauri/src/commands.rs`, `src-tauri/tests/ipc_fixtures.rs`, `docs/ipc-contract.md`
- Create: `src/shared/ipc/fixtures/revision.json`

- [ ] **Step 1: Write the failing contract test**

Create `src/shared/ipc/fixtures/revision.json`:

```json
{
  "revision": 3,
  "current": true,
  "createdAt": "2026-10-05T10:00:00Z",
  "changeCause": null,
  "images": ["nginx:1.27"],
  "template": "metadata:\n  labels:\n    app: web\nspec:\n  containers:\n  - image: nginx:1.27\n    name: web\n"
}
```

Append to `src-tauri/tests/ipc_fixtures.rs`:

```rust
#[test]
fn revision() {
    use wiring_lib::session::rollout::Revision;
    assert_matches(
        "revision",
        &Revision {
            revision: 3,
            current: true,
            created_at: Some("2026-10-05T10:00:00Z".into()),
            change_cause: None,
            images: vec!["nginx:1.27".into()],
            template: "metadata:\n  labels:\n    app: web\nspec:\n  containers:\n  - image: nginx:1.27\n    name: web\n".into(),
        },
    );
}
```

- [ ] **Step 2: Run it**

Run: `cd src-tauri && rtk proxy cargo test --test ipc_fixtures revision`
Expected: PASS (the type exists since Task 2; this pins its JSON shape before the commands use it).

- [ ] **Step 3: Open up the write helpers to the sibling module**

In `src-tauri/src/session/write.rs` change the four signatures (bodies unchanged):

```rust
pub(super) fn resource_for(kind: Kind) -> AppResult<ApiResource> {
```
```rust
pub(super) fn store_saved(store: &mut Store, obj: Object) -> bool {
```
```rust
pub(super) fn kube_err(e: kube::Error) -> AppError {
```
```rust
    pub(super) fn dynamic_api(&self, ar: &ApiResource, namespace: Option<&str>) -> Api<DynamicObject> {
```

- [ ] **Step 4: Add the Session methods**

Extend the imports at the top of `src-tauri/src/session/rollout.rs`:

```rust
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::core::DynamicObject;

use super::write::{kube_err, resource_for, store_saved};
use super::{parse_node_id, ObjectDetails, Session};
```

Add above `#[cfg(test)]`:

```rust
impl Session {
    /// The watched object `node_id` names, cloned so no lock is held across awaits.
    fn cached(&self, kind: Kind, namespace: Option<&str>, name: &str, node_id: &str) -> AppResult<Object> {
        self.shared
            .store()
            .find(kind, namespace, name)
            .cloned()
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in store")))
    }

    /// Store the server's answer and rebuild at once (as `update_object` does), so the returned
    /// details and the node's badges are fresh before the watch echo.
    async fn save_patched(&self, node_id: &str, saved: DynamicObject) -> AppResult<ObjectDetails> {
        let value = serde_json::to_value(saved).map_err(|e| AppError::internal(e.to_string()))?;
        let obj = Object::from_json_value(value).map_err(AppError::internal)?;
        let stored = store_saved(&mut self.shared.store(), obj);
        if stored {
            self.request_rebuild().await?;
        }
        self.get_object(node_id)
    }

    /// `kubectl scale`: a merge patch on the `/scale` subresource, then the object itself.
    pub async fn scale_object(&self, node_id: &str, replicas: i64) -> AppResult<ObjectDetails> {
        let (kind, ns, name) = parse_node_id(node_id)?;
        check_scale(kind, replicas)?;
        let api = self.dynamic_api(&resource_for(kind)?, ns.as_deref());
        api.patch_scale(&name, &PatchParams::default(), &Patch::Merge(scale_patch(replicas)))
            .await
            .map_err(kube_err)?;
        let saved = api.get(&name).await.map_err(kube_err)?;
        self.save_patched(node_id, saved).await
    }

    /// `kubectl rollout restart`: stamp the pod template so the controller rolls every pod.
    pub async fn restart_object(&self, node_id: &str) -> AppResult<ObjectDetails> {
        let (kind, ns, name) = parse_node_id(node_id)?;
        check_rollout_kind(kind)?;
        check_not_paused(&self.cached(kind, ns.as_deref(), &name, node_id)?)?;
        let now = k8s_openapi::jiff::Timestamp::now().to_string();
        let api = self.dynamic_api(&resource_for(kind)?, ns.as_deref());
        let saved = api
            .patch(&name, &PatchParams::default(), &Patch::Merge(restart_patch(&now)))
            .await
            .map_err(kube_err)?;
        self.save_patched(node_id, saved).await
    }

    async fn history(&self, node_id: &str) -> AppResult<Vec<HistoryEntry>> {
        let (kind, ns, name) = parse_node_id(node_id)?;
        check_rollout_kind(kind)?;
        let obj = self.cached(kind, ns.as_deref(), &name, node_id)?;
        let (uid, selector, update_revision) = match &obj {
            Object::Deployment(d) => return Ok(deployment_history(&self.shared.store(), d)),
            Object::StatefulSet(s) => (
                s.metadata.uid.clone(),
                s.spec.as_ref().map(|sp| selector_string(&sp.selector)),
                s.status.as_ref().and_then(|st| st.update_revision.clone()),
            ),
            Object::DaemonSet(d) => (d.metadata.uid.clone(), d.spec.as_ref().map(|sp| selector_string(&sp.selector)), None),
            _ => return Err(AppError::internal(format!("{node_id} has no rollout"))),
        };
        let uid = uid.ok_or_else(|| AppError::internal(format!("{node_id} has no uid")))?;
        let ns = ns.ok_or_else(|| AppError::internal(format!("{node_id} has no namespace")))?;
        let api: Api<ControllerRevision> = Api::namespaced(self.client.clone(), &ns);
        let selector = selector.unwrap_or_default();
        let params = if selector.is_empty() { ListParams::default() } else { ListParams::default().labels(&selector) };
        let list = api.list(&params).await.map_err(kube_err)?;
        Ok(controller_history(&uid, update_revision.as_deref(), &list.items))
    }

    /// Revisions newest first; a role that cannot list controllerrevisions gets `forbidden`.
    pub async fn rollout_history(&self, node_id: &str) -> AppResult<Vec<Revision>> {
        Ok(self.history(node_id).await?.into_iter().map(|e| e.revision).collect())
    }

    /// `kubectl rollout undo --to-revision`: apply the revision's template as a strategic merge patch.
    pub async fn rollback_object(&self, node_id: &str, revision: i64) -> AppResult<ObjectDetails> {
        let (kind, ns, name) = parse_node_id(node_id)?;
        check_rollout_kind(kind)?;
        check_not_paused(&self.cached(kind, ns.as_deref(), &name, node_id)?)?;
        let entries = self.history(node_id).await?;
        let patch = pick_rollback(&entries, revision)?.clone();
        let api = self.dynamic_api(&resource_for(kind)?, ns.as_deref());
        let saved = api
            .patch(&name, &PatchParams::default(), &Patch::Strategic(patch))
            .await
            .map_err(kube_err)?;
        self.save_patched(node_id, saved).await
    }
}
```

- [ ] **Step 5: Add the Tauri commands**

In `src-tauri/src/commands.rs` add the import:

```rust
use crate::session::rollout::Revision;
```

add after `delete_object`:

```rust
#[tauri::command]
pub async fn scale_object(state: State<'_, AppState>, node_id: String, replicas: i64) -> AppResult<ObjectDetails> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.scale_object(&node_id, replicas).await
}

#[tauri::command]
pub async fn restart_object(state: State<'_, AppState>, node_id: String) -> AppResult<ObjectDetails> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.restart_object(&node_id).await
}

#[tauri::command]
pub async fn rollout_history(state: State<'_, AppState>, node_id: String) -> AppResult<Vec<Revision>> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.rollout_history(&node_id).await
}

#[tauri::command]
pub async fn rollback_object(state: State<'_, AppState>, node_id: String, revision: i64) -> AppResult<ObjectDetails> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.rollback_object(&node_id, revision).await
}
```

and register them in `generate_handler!` after `delete_object,`:

```rust
        scale_object,
        restart_object,
        rollout_history,
        rollback_object,
```

- [ ] **Step 6: Document the contract**

In `docs/ipc-contract.md`, add four rows to the Commands table after `delete_object`:

```markdown
| `scale_object` | `{ nodeId, replicas }` | `ObjectDetails` (see [Rollout actions](#rollout-actions)) |
| `restart_object` | `{ nodeId }` | `ObjectDetails` |
| `rollout_history` | `{ nodeId }` | `Revision[]`, newest first |
| `rollback_object` | `{ nodeId, revision }` | `ObjectDetails` |
```

and a new section after `### Writes` (before `## Events (\`listen\`)`):

```markdown
### Rollout actions

- `scale_object` takes a Deployment or StatefulSet and an integer `replicas` in 0 … 10 000; anything else is `invalid` before a request is sent. It patches the `/scale` subresource (as `kubectl scale`), then returns the object's fresh details.
- `restart_object`, `rollout_history` and `rollback_object` take a Deployment, StatefulSet or DaemonSet (PodGroup and every other kind: `invalid`). Restart sets `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` (as `kubectl rollout restart`). Restart and rollback on a paused Deployment are `invalid` ("deployment is paused; resume it first").
- `Revision = { revision: number, current: boolean, createdAt: string | null, changeCause: string | null, images: string[], template: string }`; `template` is the pod template as YAML. Deployment revisions come from its ReplicaSets in the cached store (`deployment.kubernetes.io/revision`; ReplicaSets without it are skipped, `pod-template-hash` is left out of `template`), the newest being current. StatefulSet/DaemonSet revisions are listed from ControllerRevisions (label selector = `matchLabels`, filtered by ownerReference uid); `current` is a StatefulSet's `status.updateRevision`, else the newest. A role without `list controllerrevisions` gets `forbidden`. Fixture: `revision.json`.
- `rollback_object` to the current revision is `invalid` ("already at revision N"); an unknown one is `notFound`. Deployments get their old template back with `$patch: replace` (as `kubectl rollout undo`); StatefulSets/DaemonSets get the revision's `data` as a strategic merge patch.
- Like `update_object`, every successful action stores the server's object and rebuilds the graph at once, so the returned details and the `graph_delta` arrive before the watch echo.
```

- [ ] **Step 7: Build and run the backend suite**

Run: `cd src-tauri && rtk proxy cargo test && rtk proxy cargo clippy --all-targets -- -D warnings`
Expected: all tests pass, clippy clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/session src-tauri/src/commands.rs src-tauri/tests/ipc_fixtures.rs src/shared/ipc/fixtures/revision.json docs/ipc-contract.md
git commit -m "$(cat <<'EOF'
Add scale, restart, rollout history and rollback commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Rolling badge and Deployment condition messages

**Files:**
- Modify: `src-tauri/src/graph/status.rs:74-123` (workload functions), `:358-385` (Deployment summary)
- Create: `src-tauri/tests/fixtures/rolling.yaml`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/tests/fixtures/rolling.yaml`:

```yaml
kind: Deployment
metadata: { name: settled, namespace: r, generation: 2 }
spec:
  replicas: 3
  selector: { matchLabels: { app: settled } }
  template:
    metadata: { labels: { app: settled } }
    spec: { containers: [ { name: c, image: "web:2" } ] }
status: { observedGeneration: 2, replicas: 3, updatedReplicas: 3, readyReplicas: 3 }
---
kind: Deployment
metadata: { name: updating, namespace: r, generation: 3 }
spec:
  replicas: 3
  selector: { matchLabels: { app: updating } }
  template:
    metadata: { labels: { app: updating } }
    spec: { containers: [ { name: c, image: "web:3" } ] }
status: { observedGeneration: 3, replicas: 4, updatedReplicas: 1, readyReplicas: 3 }
---
kind: Deployment
metadata: { name: unseen, namespace: r, generation: 4 }
spec:
  replicas: 3
  selector: { matchLabels: { app: unseen } }
  template:
    metadata: { labels: { app: unseen } }
    spec: { containers: [ { name: c, image: "web:4" } ] }
status: { observedGeneration: 3, replicas: 3, updatedReplicas: 3, readyReplicas: 3 }
---
kind: Deployment
metadata: { name: deadline, namespace: r, generation: 2 }
spec:
  replicas: 3
  selector: { matchLabels: { app: deadline } }
  template:
    metadata: { labels: { app: deadline } }
    spec: { containers: [ { name: c, image: "web:bad" } ] }
status:
  observedGeneration: 2
  replicas: 3
  updatedReplicas: 1
  readyReplicas: 0
  conditions:
    - type: Progressing
      status: "False"
      reason: ProgressDeadlineExceeded
      message: ReplicaSet "deadline-2" has timed out progressing.
---
kind: StatefulSet
metadata: { name: db, namespace: r, generation: 2 }
spec:
  replicas: 3
  serviceName: db
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec: { containers: [ { name: c, image: "postgres:17" } ] }
status: { observedGeneration: 2, replicas: 3, readyReplicas: 3, updatedReplicas: 1 }
---
kind: DaemonSet
metadata: { name: agent, namespace: r, generation: 5 }
spec:
  selector: { matchLabels: { app: agent } }
  template:
    metadata: { labels: { app: agent } }
    spec: { containers: [ { name: c, image: "agent:3" } ] }
status: { observedGeneration: 5, desiredNumberScheduled: 4, numberReady: 4, currentNumberScheduled: 4, numberMisscheduled: 0, updatedNumberScheduled: 2 }
```

Append inside `mod tests` in `src-tauri/src/graph/status.rs`:

```rust
    fn describe_rolling(kind: Kind, name: &str) -> (Status, Vec<String>) {
        let s = Store::from_fixture("rolling").unwrap();
        describe(s.find(kind, Some("r"), name).unwrap(), &s)
    }

    #[test]
    fn rollouts_in_progress_get_a_rolling_badge() {
        let strs = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(describe_rolling(Kind::Deployment, "settled"), (Status::Ok, strs(&["3/3", "web:2"])));
        assert_eq!(
            describe_rolling(Kind::Deployment, "updating"),
            (Status::Warn, strs(&["3/3", "rolling 1/3", "web:3"]))
        );
        // The controller has not seen the latest spec yet.
        assert_eq!(
            describe_rolling(Kind::Deployment, "unseen"),
            (Status::Warn, strs(&["3/3", "rolling 3/3", "web:4"]))
        );
        // A stuck rollout stays an error.
        assert_eq!(
            describe_rolling(Kind::Deployment, "deadline"),
            (Status::Err, strs(&["0/3", "rolling 1/3", "web:bad"]))
        );
        assert_eq!(
            describe_rolling(Kind::StatefulSet, "db"),
            (Status::Warn, strs(&["3/3", "rolling 1/3", "postgres:17"]))
        );
        assert_eq!(
            describe_rolling(Kind::DaemonSet, "agent"),
            (Status::Warn, strs(&["4/4", "rolling 2/4", "agent:3"]))
        );
    }

    #[test]
    fn deployment_overview_carries_the_condition_message() {
        let s = Store::from_fixture("rolling").unwrap();
        let rows = summary(s.find(Kind::Deployment, Some("r"), "deadline").unwrap());
        assert!(
            rows.iter().any(|(k, v)| k == "Condition Progressing"
                && v == "False ProgressDeadlineExceeded — ReplicaSet \"deadline-2\" has timed out progressing."),
            "{rows:?}"
        );
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd src-tauri && rtk proxy cargo test --lib graph::status`
Expected: FAIL — `updating` returns `(Ok, ["3/3", "web:3"])` (no rolling badge, all replicas ready); the condition row lacks the message. The existing `deployment_statuses` test still passes.

- [ ] **Step 3: Implement**

In `src-tauri/src/graph/status.rs`, add after `workload_status`:

```rust
/// `rolling updated/desired` while a rollout runs: the controller has not observed the latest
/// generation, or not every replica runs the new template yet. Missing fields (old servers,
/// hand-written fixtures) never count as rolling.
fn rolling(generation: Option<i64>, observed: Option<i64>, updated: Option<i32>, desired: i32) -> Option<String> {
    let unseen = matches!((generation, observed), (Some(g), Some(o)) if o < g);
    let behind = updated.is_some_and(|u| u < desired);
    (unseen || behind).then(|| format!("rolling {}/{desired}", updated.unwrap_or(0)))
}

/// Push the rolling badge (if any) and lift an otherwise healthy workload to a warning.
fn with_rollout(status: Status, rolling: Option<String>, badges: &mut Badges) -> Status {
    let Some(badge) = rolling else { return status };
    badges.push(badge);
    if status == Status::Ok {
        Status::Warn
    } else {
        status
    }
}
```

Replace `deployment`, `statefulset` and `daemonset` with:

```rust
fn deployment(d: &Deployment) -> (Status, Badges) {
    let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let st = d.status.as_ref();
    let ready = st.and_then(|s| s.ready_replicas).unwrap_or(0);
    let progressing_false = st
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| condition_is(cs.iter().map(|c| (c.type_.as_str(), c.status.as_str())), "Progressing", "False"))
        .unwrap_or(false);
    let mut badges = vec![ready_desired(ready, desired)];
    let rollout = rolling(
        d.metadata.generation,
        st.and_then(|s| s.observed_generation),
        st.and_then(|s| s.updated_replicas),
        desired,
    );
    let status = with_rollout(workload_status(ready, desired, progressing_false), rollout, &mut badges);
    if let Some(img) = d
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| first_image(&ps.containers))
    {
        badges.push(img);
    }
    (status, badges)
}

fn statefulset(s: &StatefulSet) -> (Status, Badges) {
    let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let st = s.status.as_ref();
    let ready = st.and_then(|s| s.ready_replicas).unwrap_or(0);
    let mut badges = vec![ready_desired(ready, desired)];
    let rollout = rolling(
        s.metadata.generation,
        st.and_then(|s| s.observed_generation),
        st.and_then(|s| s.updated_replicas),
        desired,
    );
    let status = with_rollout(workload_status(ready, desired, false), rollout, &mut badges);
    if let Some(img) = s
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| first_image(&ps.containers))
    {
        badges.push(img);
    }
    (status, badges)
}

fn daemonset(d: &DaemonSet) -> (Status, Badges) {
    let st = d.status.as_ref();
    let desired = st.map(|s| s.desired_number_scheduled).unwrap_or(0);
    let ready = st.map(|s| s.number_ready).unwrap_or(0);
    let mut badges = vec![ready_desired(ready, desired)];
    let rollout = rolling(
        d.metadata.generation,
        st.and_then(|s| s.observed_generation),
        st.and_then(|s| s.updated_number_scheduled),
        desired,
    );
    let status = with_rollout(workload_status(ready, desired, false), rollout, &mut badges);
    if let Some(img) = d
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| first_image(&ps.containers))
    {
        badges.push(img);
    }
    (status, badges)
}
```

In `summary`, inside `Object::Deployment(d) => { … }`, replace the conditions block with:

```rust
            if let Some(cs) = st.and_then(|s| s.conditions.as_ref()) {
                rows.extend(cs.iter().map(|c| {
                    let mut text = format!("{} {}", c.status, c.reason.clone().unwrap_or_default());
                    // The message says why a rollout is stuck (which ReplicaSet, which deadline).
                    if let Some(m) = c.message.as_deref().filter(|m| !m.is_empty()) {
                        text.push_str(" — ");
                        text.push_str(m);
                    }
                    (format!("Condition {}", c.type_), text)
                }));
            }
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && rtk proxy cargo test`
Expected: all pass (the existing `statuses` fixtures carry no `generation`/`updatedReplicas`, so their badges are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/status.rs src-tauri/tests/fixtures/rolling.yaml
git commit -m "$(cat <<'EOF'
Show a rolling badge while a workload rolls out; add condition messages to Overview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Smoke test for the rollout actions

**Files:**
- Modify: `src-tauri/tests/fixtures/smoke.yaml`, `src-tauri/tests/smoke.rs`

- [ ] **Step 1: Add a StatefulSet to the smoke namespace**

Append to `src-tauri/tests/fixtures/smoke.yaml`:

```yaml
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db, namespace: wiring-smoke }
spec:
  replicas: 1
  serviceName: db
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec: { containers: [ { name: db, image: "registry.k8s.io/pause:3.9" } ] }
```

- [ ] **Step 2: Write the rollout exercise**

In `src-tauri/tests/smoke.rs`, extend the module doc's first line to `… exercise the write path (update / conflict / create / delete / PodGroup delete), the rollout actions (scale / restart / history / rollback) and log streaming …`, add the import:

```rust
use wiring_lib::session::rollout::Revision;
```

and add after `exercise_writes`:

```rust
const WEB_ID: &str = "Deployment/wiring-smoke/web";
const DB_ID: &str = "StatefulSet/wiring-smoke/db";

/// Poll `rollout_history` until `ok` holds or two minutes pass; returns the last answer.
async fn history_until(session: &Session, node_id: &str, ok: impl Fn(&[Revision]) -> bool) -> Vec<Revision> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let revisions = session.rollout_history(node_id).await.unwrap();
        if ok(&revisions) || tokio::time::Instant::now() > deadline {
            return revisions;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Scale, restart and roll back the `web` Deployment and the `db` StatefulSet.
async fn exercise_rollout(session: &Session, rx: &mut UnboundedReceiver<OutEvent>, graph: &mut Graph, context: &str) {
    // (1) Scale through /scale; the returned details already carry the new spec.
    let details = session.scale_object(WEB_ID, 2).await.unwrap();
    assert!(details.yaml.contains("replicas: 2"), "{}", details.yaml);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let ok = graph_until(rx, graph, deadline, |g| {
        g.node(WEB_ID).is_some_and(|n| n.badges.first().map(String::as_str) == Some("2/2"))
    })
    .await;
    assert!(ok, "web never settled at 2/2; last graph: {graph:#?}");
    for (id, n) in [(WEB_ID, -1), (WEB_ID, 10_001), (CONFIGMAP_ID, 1)] {
        let err = session.scale_object(id, n).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid, "{id} {n}: {err:?}");
    }

    // (2) Restart: a new current revision whose template carries the restartedAt stamp.
    let before = session.rollout_history(WEB_ID).await.unwrap();
    let top = before.iter().map(|r| r.revision).max().expect("web has a revision");
    session.restart_object(WEB_ID).await.unwrap();
    let after = history_until(session, WEB_ID, |r| r.iter().any(|r| r.current && r.revision > top)).await;
    let current = after.iter().find(|r| r.current).unwrap_or_else(|| panic!("{after:#?}"));
    assert!(current.revision > top, "{after:#?}");
    assert!(current.template.contains("kubectl.kubernetes.io/restartedAt"), "{}", current.template);
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "deployment/web", "--timeout=180s"]);

    // (3) Roll back to the pre-restart revision: the stamp is gone from the live template.
    let err = session.rollback_object(WEB_ID, current.revision).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
    let err = session.rollback_object(WEB_ID, 999).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound, "{err:?}");
    let details = session.rollback_object(WEB_ID, top).await.unwrap();
    assert!(!details.yaml.contains("restartedAt"), "{}", details.yaml);
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "deployment/web", "--timeout=180s"]);

    // (4) The same through ControllerRevisions for a StatefulSet.
    let before = history_until(session, DB_ID, |r| !r.is_empty()).await;
    assert_eq!(before.len(), 1, "{before:#?}");
    session.restart_object(DB_ID).await.unwrap();
    let after = history_until(session, DB_ID, |r| r.len() == 2 && r[0].current).await;
    assert!(after.len() == 2 && after[0].current, "{after:#?}");
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "statefulset/db", "--timeout=180s"]);
    let details = session.rollback_object(DB_ID, after[1].revision).await.unwrap();
    assert!(!details.yaml.contains("restartedAt"), "{}", details.yaml);
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "statefulset/db", "--timeout=180s"]);

    // (5) Kinds without a rollout are refused before any request.
    for err in [
        session.restart_object(CONFIGMAP_ID).await.unwrap_err(),
        session.rollout_history(CONFIGMAP_ID).await.unwrap_err(),
        session.rollback_object(GROUP_ID, 1).await.unwrap_err(),
    ] {
        assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
    }
}
```

In `graph_snapshot_reflects_applied_fixture`, after the existing `rollout status deployment/web` call add:

```rust
    kubectl(&context, &["-n", NAMESPACE, "rollout", "status", "statefulset/db", "--timeout=180s"]);
```

and between `exercise_writes(…).await;` and `exercise_logs(…).await;` add:

```rust
    exercise_rollout(&session, &mut rx, &mut graph, &context).await;
```

- [ ] **Step 3: Run the smoke test against a local cluster**

Run: `cd src-tauri && WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored --nocapture`
Expected: `test graph_snapshot_reflects_applied_fixture ... ok`. If no local cluster is available, run `rtk proxy cargo test --test smoke --no-run` (must compile) and say in the task report that the live run is pending.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/smoke.rs src-tauri/tests/fixtures/smoke.yaml
git commit -m "$(cat <<'EOF'
Exercise scale, restart and rollback in the live smoke test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Frontend IPC types and commands

**Files:**
- Modify: `src/shared/ipc/types.ts`, `src/shared/ipc/commands.ts`, `src/shared/ipc/fixtures.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/shared/ipc/fixtures.test.ts` add the import `import revision from "./fixtures/revision.json";`, add `isRevision` to the import list from `./types`, and add inside the `describe`:

```ts
  it("revision", () => expect(isRevision(revision)).toBe(true));

  it("rejects a revision without images", () => {
    expect(isRevision({ ...revision, images: undefined })).toBe(false);
  });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `rtk proxy pnpm vitest run src/shared/ipc/fixtures.test.ts`
Expected: FAIL — `isRevision` is not exported.

- [ ] **Step 3: Implement**

In `src/shared/ipc/types.ts`, after `LogRequest`:

```ts
export interface Revision {
  revision: number;
  current: boolean;
  createdAt: string | null;
  changeCause: string | null;
  images: string[];
  /** The revision's pod template as YAML. */
  template: string;
}
```

and after `isLogMessage`:

```ts
export function isRevision(v: unknown): v is Revision {
  return isObj(v) && typeof v.revision === "number" && typeof v.current === "boolean" && isStrOrNull(v.createdAt)
    && isStrOrNull(v.changeCause) && arrayOf(v.images, isStr) && isStr(v.template);
}
```

In `src/shared/ipc/commands.ts` add `Revision` to the type import and, after `deleteObject`:

```ts
  scaleObject: (nodeId: NodeId, replicas: number) => call<ObjectDetails>("scale_object", { nodeId, replicas }),
  restartObject: (nodeId: NodeId) => call<ObjectDetails>("restart_object", { nodeId }),
  rolloutHistory: (nodeId: NodeId) => call<Revision[]>("rollout_history", { nodeId }),
  rollbackObject: (nodeId: NodeId, revision: number) => call<ObjectDetails>("rollback_object", { nodeId, revision }),
```

- [ ] **Step 4: Run the tests**

Run: `rtk proxy pnpm vitest run src/shared/ipc && rtk proxy pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc
git commit -m "$(cat <<'EOF'
Add the rollout action commands and Revision type to the frontend IPC

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Action helpers (kinds, replicas, HPA, age)

**Files:**
- Create: `src/features/actions/actionKinds.ts`, `src/features/actions/actionKinds.test.ts`, `src/features/actions/age.ts`, `src/features/actions/age.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/features/actions/actionKinds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../shared/ipc/types";
import { actionsFor, desiredReplicas, describeId, hpaFor, kindOf } from "./actionKinds";

const node = (id: string, kind: GraphNode["kind"], badges: string[]): GraphNode => ({
  id, kind, namespace: "p", name: id.split("/").pop()!, status: "ok", badges, group: null,
});

describe("actionKinds", () => {
  it("offers scale, restart and rollback by kind, and delete for everything", () => {
    expect(actionsFor("Deployment")).toEqual(["scale", "restart", "rollback", "delete"]);
    expect(actionsFor("StatefulSet")).toEqual(["scale", "restart", "rollback", "delete"]);
    expect(actionsFor("DaemonSet")).toEqual(["restart", "rollback", "delete"]);
    expect(actionsFor("Pod")).toEqual(["delete"]);
    expect(actionsFor("PodGroup")).toEqual(["delete"]);
    expect(actionsFor(null)).toEqual(["delete"]);
  });

  it("reads the kind and a label from a node id", () => {
    expect(kindOf("Deployment/p/web")).toBe("Deployment");
    expect(kindOf("Bogus/p/x")).toBeNull();
    expect(describeId("StatefulSet/p/db")).toBe("StatefulSet db");
  });

  it("takes the desired replicas from the ready/desired badge", () => {
    expect(desiredReplicas(node("Deployment/p/web", "Deployment", ["2/3", "nginx:1.27"]))).toBe(3);
    expect(desiredReplicas(node("Deployment/p/web", "Deployment", []))).toBe(1);
    expect(desiredReplicas(undefined)).toBe(1);
  });

  it("finds the HPA that scales a node, with min and max from its badge", () => {
    const hpa = node("HorizontalPodAutoscaler/p/web-hpa", "HorizontalPodAutoscaler", ["2–10", "3"]);
    const edges: GraphEdge[] = [
      { id: "e1", source: hpa.id, target: "Deployment/p/web", relation: "scales" },
      { id: "e2", source: "Service/p/web", target: "Deployment/p/web", relation: "selects" },
    ];
    const nodes = new Map([[hpa.id, hpa]]);
    expect(hpaFor("Deployment/p/web", edges, nodes)).toEqual({ name: "web-hpa", min: 2, max: 10 });
    expect(hpaFor("Deployment/p/api", edges, nodes)).toBeNull();
    // An HPA hidden from the graph still has its edge's id: name only.
    expect(hpaFor("Deployment/p/web", edges, new Map())).toEqual({ name: "web-hpa", min: null, max: null });
  });
});
```

`src/features/actions/age.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { age } from "./age";

describe("age", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  it("formats seconds, minutes, hours and days", () => {
    expect(age("2026-10-05T11:59:15Z", now)).toBe("45s");
    expect(age("2026-10-05T11:48:00Z", now)).toBe("12m");
    expect(age("2026-10-05T09:00:00Z", now)).toBe("3h");
    expect(age("2026-09-30T12:00:00Z", now)).toBe("5d");
  });
  it("shows a dash for a missing or unparseable time", () => {
    expect(age(null, now)).toBe("—");
    expect(age("soon", now)).toBe("—");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `rtk proxy pnpm vitest run src/features/actions`
Expected: FAIL — modules `./actionKinds` and `./age` not found.

- [ ] **Step 3: Implement**

`src/features/actions/actionKinds.ts`:

```ts
import { KINDS, type GraphEdge, type GraphNode, type Kind, type NodeId } from "../../shared/ipc/types";
import { KIND_META } from "../graph/kindMeta";

/** Mirrors the backend's bound on a manual scale. */
export const MAX_REPLICAS = 10_000;
export const SCALE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["Deployment", "StatefulSet"]);
export const ROLLOUT_KINDS: ReadonlySet<Kind> = new Set<Kind>(["Deployment", "StatefulSet", "DaemonSet"]);

export type ActionId = "scale" | "restart" | "rollback" | "delete";

/** The Actions menu items for a kind, in menu order; everything can be deleted. */
export function actionsFor(kind: Kind | null): ActionId[] {
  const out: ActionId[] = [];
  if (kind && SCALE_KINDS.has(kind)) out.push("scale");
  if (kind && ROLLOUT_KINDS.has(kind)) out.push("restart", "rollback");
  out.push("delete");
  return out;
}

export function kindOf(id: NodeId): Kind | null {
  const head = id.split("/")[0];
  return (KINDS as readonly string[]).includes(head) ? (head as Kind) : null;
}

/** "Deployment web" from `Deployment/ns/web`, for dialog titles. */
export function describeId(id: NodeId): string {
  const kind = kindOf(id);
  const name = id.split("/").pop() ?? id;
  return kind ? `${KIND_META[kind].label} ${name}` : name;
}

/** The desired replica count from a workload node's first badge (`ready/desired`); 1 if unknown. */
export function desiredReplicas(node: GraphNode | undefined): number {
  const m = node?.badges[0]?.match(/^\d+\/(\d+)$/);
  return m ? Number(m[1]) : 1;
}

export interface HpaInfo { name: string; min: number | null; max: number | null }

/** The HPA whose `scales` edge targets `nodeId`; min/max come from its `min–max` badge. */
export function hpaFor(nodeId: NodeId, edges: Iterable<GraphEdge>, nodes: Map<NodeId, GraphNode>): HpaInfo | null {
  for (const e of edges) {
    if (e.relation !== "scales" || e.target !== nodeId) continue;
    const hpa = nodes.get(e.source);
    const m = hpa?.badges[0]?.match(/^(\d+)–(\d+)$/);
    return { name: hpa?.name ?? e.source.split("/").pop()!, min: m ? Number(m[1]) : null, max: m ? Number(m[2]) : null };
  }
  return null;
}
```

`src/features/actions/age.ts`:

```ts
/** kubectl-style age of `iso` at `now`: "45s", "12m", "3h", "5d"; "—" when unknown. */
export function age(iso: string | null, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}
```

- [ ] **Step 4: Run the tests**

Run: `rtk proxy pnpm vitest run src/features/actions && rtk proxy pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/actions
git commit -m "$(cat <<'EOF'
Add helpers for the workload actions: kinds, replicas, HPA lookup, age

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Store state and actions; Escape

**Files:**
- Modify: `src/app/store.ts`, `src/app/useGlobalKeys.ts`, `src/app/useGlobalKeys.test.tsx`
- Create: `src/app/store.actions.test.ts`

- [ ] **Step 1: Write the failing store tests**

`src/app/store.actions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_object" ? { yaml: "kind: Deployment\n", summary: [], related: [] } : null)),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));
vi.mock("../shared/settings", () => ({
  settings: {
    get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastNamespace: vi.fn(async () => null), setLastNamespace: vi.fn(async () => {}),
    getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}),
  },
}));

import { invoke } from "../shared/ipc/tauri";
import { initialState, useAppStore, viewEditor } from "./store";

const WEB = "Deployment/p/web";
const fresh = { yaml: "kind: Deployment\nspec:\n  replicas: 5\n", summary: [["Name", "web"]] as [string, string][], related: [] };
const selectWeb = (mode: "view" | "edit" = "view") => useAppStore.setState({
  selectedId: WEB,
  details: { nodeId: WEB, data: { yaml: "old", summary: [], related: [] }, events: [], loading: false, editor: mode === "view" ? viewEditor("old") : { ...viewEditor("old"), mode: "edit", buffer: "mine" } },
});

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockClear();
});

describe("actions menu", () => {
  it("opens at the pointer and selects the object", async () => {
    useAppStore.getState().openActionsMenu(WEB, 10, 20);
    expect(useAppStore.getState().actionsMenu).toEqual({ nodeId: WEB, x: 10, y: 20 });
    await vi.waitFor(() => expect(useAppStore.getState().selectedId).toBe(WEB));
    useAppStore.getState().closeActionsMenu();
    expect(useAppStore.getState().actionsMenu).toBeNull();
  });

  it("stays closed when leaving a dirty editor needs confirmation first", () => {
    selectWeb("edit");
    useAppStore.getState().openActionsMenu("StatefulSet/p/db", 0, 0);
    expect(useAppStore.getState().discardDialog.open).toBe(true);
    expect(useAppStore.getState().actionsMenu).toBeNull();
  });

  it("requested details tabs are handed over once", () => {
    useAppStore.getState().requestTab("history");
    expect(useAppStore.getState().requestedTab).toBe("history");
    useAppStore.getState().consumeRequestedTab();
    expect(useAppStore.getState().requestedTab).toBeNull();
  });
});

describe("rollout actions", () => {
  it("scaleObject calls the backend, refreshes the details, closes the dialog and toasts", async () => {
    selectWeb();
    useAppStore.getState().openActionDialog({ type: "scale", nodeId: WEB });
    vi.mocked(invoke).mockResolvedValueOnce(fresh);
    await useAppStore.getState().scaleObject(WEB, 5);
    expect(invoke).toHaveBeenCalledWith("scale_object", { nodeId: WEB, replicas: 5 });
    const s = useAppStore.getState();
    expect(s.actionDialog).toBeNull();
    expect(s.actionBusy).toBe(false);
    expect(s.details?.data).toEqual(fresh);
    expect(s.details?.editor).toEqual(viewEditor(fresh.yaml));
    expect(s.toasts.at(-1)).toMatchObject({ kind: "info", message: "Scaled Deployment web to 5" });
  });

  it("does not overwrite an edit in progress", async () => {
    selectWeb("edit");
    vi.mocked(invoke).mockResolvedValueOnce(fresh);
    await useAppStore.getState().restartObject(WEB);
    expect(invoke).toHaveBeenCalledWith("restart_object", { nodeId: WEB });
    expect(useAppStore.getState().details?.editor.buffer).toBe("mine");
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Restarted Deployment web" });
  });

  it("rollbackObject names the revision", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(fresh);
    await useAppStore.getState().rollbackObject(WEB, 3);
    expect(invoke).toHaveBeenCalledWith("rollback_object", { nodeId: WEB, revision: 3 });
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Rolled Deployment web back to revision 3" });
  });

  it("a failure is toasted and closes the dialog", async () => {
    useAppStore.getState().openActionDialog({ type: "restart", nodeId: WEB });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "invalid", message: "deployment is paused; resume it first" });
    await useAppStore.getState().restartObject(WEB);
    expect(useAppStore.getState().actionDialog).toBeNull();
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "invalid", message: "deployment is paused; resume it first" });
  });

  it("ignores a second action while one is in flight", async () => {
    useAppStore.setState({ actionBusy: true });
    await useAppStore.getState().scaleObject(WEB, 2);
    expect(invoke).not.toHaveBeenCalled();
  });
});
```

Append to `src/app/useGlobalKeys.test.tsx` inside `describe("global keys", …)`:

```ts
  it("Escape closes the actions menu, then an action dialog, before touching the selection", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", state: "connected" }, selectedId: "Deployment/p/web", select,
      actionsMenu: { nodeId: "Deployment/p/web", x: 0, y: 0 },
    });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().actionsMenu).toBeNull();
    useAppStore.setState({ actionDialog: { type: "restart", nodeId: "Deployment/p/web" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().actionDialog).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `rtk proxy pnpm vitest run src/app/store.actions.test.ts src/app/useGlobalKeys.test.tsx`
Expected: FAIL — `openActionsMenu is not a function` and type errors for the new fields.

- [ ] **Step 3: Implement the store**

In `src/app/store.ts`:

After `export interface DiscardDialog …` add:

```ts
/** The Actions menu, open for `nodeId` at viewport position (x, y). */
export interface ActionsMenu { nodeId: NodeId; x: number; y: number }
export type ActionDialog =
  | { type: "scale"; nodeId: NodeId }
  | { type: "restart"; nodeId: NodeId }
  | { type: "rollback"; nodeId: NodeId; revision: number };
export type DetailsTab = "overview" | "yaml" | "events" | "logs" | "history";
```

In `interface AppState`, after `logs: LogsState;`:

```ts
  actionsMenu: ActionsMenu | null;
  actionDialog: ActionDialog | null;
  /** A scale/restart/rollback request is in flight; a second one is ignored. */
  actionBusy: boolean;
  /** A tab the details panel should switch to once it shows the selection (e.g. Rollback… → History). */
  requestedTab: DetailsTab | null;
```

and, after the `// logs` action signatures (before `toggleDetailsMaximized`):

```ts
  // workload actions
  /** Select `nodeId` and open the Actions menu for it at (x, y), unless a dirty editor asks first. */
  openActionsMenu: (nodeId: NodeId, x: number, y: number) => void;
  closeActionsMenu: () => void;
  openActionDialog: (dialog: ActionDialog) => void;
  closeActionDialog: () => void;
  scaleObject: (nodeId: NodeId, replicas: number) => Promise<void>;
  restartObject: (nodeId: NodeId) => Promise<void>;
  rollbackObject: (nodeId: NodeId, revision: number) => Promise<void>;
  requestTab: (tab: DetailsTab) => void;
  consumeRequestedTab: () => void;
```

In `initialState()`, after `logs: initialLogs(),`:

```ts
    actionsMenu: null,
    actionDialog: null,
    actionBusy: false,
    requestedTab: null,
```

Extend the `Actions` type list: replace `| "toggleLogsTimestamps" | "toggleDetailsMaximized">;` with

```ts
  | "toggleLogsTimestamps" | "toggleDetailsMaximized" | "openActionsMenu" | "closeActionsMenu" | "openActionDialog"
  | "closeActionDialog" | "scaleObject" | "restartObject" | "rollbackObject" | "requestTab" | "consumeRequestedTab">;
```

In the `create(...)` object, after `toggleDetailsMaximized: …,` add:

```ts
  openActionsMenu: (nodeId, x, y) => {
    void get().select(nodeId);
    // `select` decides synchronously whether a dirty editor must be confirmed first; then no menu.
    if (get().discardDialog.open) return;
    set({ actionsMenu: { nodeId, x, y } });
  },
  closeActionsMenu: () => set({ actionsMenu: null }),
  openActionDialog: (dialog) => set({ actionDialog: dialog }),
  closeActionDialog: () => set({ actionDialog: null }),
  scaleObject: (nodeId, replicas) =>
    runAction(nodeId, () => commands.scaleObject(nodeId, replicas), `Scaled ${describeNode(nodeId)} to ${replicas}`),
  restartObject: (nodeId) => runAction(nodeId, () => commands.restartObject(nodeId), `Restarted ${describeNode(nodeId)}`),
  rollbackObject: (nodeId, revision) =>
    runAction(nodeId, () => commands.rollbackObject(nodeId, revision), `Rolled ${describeNode(nodeId)} back to revision ${revision}`),
  requestTab: (tab) => set({ requestedTab: tab }),
  consumeRequestedTab: () => set({ requestedTab: null }),
```

After the store (next to `loadDetails`), add:

```ts
/** A scale/restart/rollback write. The open details take the returned object unless an edit is in
 *  progress there (its own conflict handling covers that); the dialog closes and a toast reports
 *  the outcome either way. */
async function runAction(nodeId: NodeId, call: () => Promise<ObjectDetails>, done: string): Promise<void> {
  if (useAppStore.getState().actionBusy) return;
  useAppStore.setState({ actionBusy: true });
  try {
    const data = await call();
    useAppStore.setState((s) => ({
      actionBusy: false,
      actionDialog: null,
      ...(s.details?.nodeId === nodeId && s.details.editor.mode === "view" ? { details: { ...s.details, data, editor: viewEditor(data.yaml) } } : {}),
    }));
    useAppStore.getState().toast({ kind: "info", message: done });
  } catch (e) {
    useAppStore.setState({ actionBusy: false, actionDialog: null });
    useAppStore.getState().toast(toAppError(e));
  }
}
```

- [ ] **Step 4: Escape closes the menu and the dialog**

In `src/app/useGlobalKeys.ts`, replace the `modal` line with:

```ts
      const modal = s.pickerOpen || s.discardDialog.open || s.deleteDialog.open || s.createDialog.open || s.actionDialog !== null || s.actionsMenu !== null;
```

and after `if (s.pickerOpen) return;` add:

```ts
      if (s.actionsMenu) { s.closeActionsMenu(); return; }
      if (s.actionDialog) { if (!s.actionBusy) s.closeActionDialog(); return; }
```

- [ ] **Step 5: Run the tests**

Run: `rtk proxy pnpm vitest run src/app && rtk proxy pnpm typecheck`
Expected: PASS (existing store tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/app/store.ts src/app/store.actions.test.ts src/app/useGlobalKeys.ts src/app/useGlobalKeys.test.tsx
git commit -m "$(cat <<'EOF'
Add store state for the Actions menu, action dialogs and rollout writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Actions menu, context menus, header button

**Files:**
- Create: `src/features/actions/ActionsMenu.tsx`, `src/features/actions/ActionsMenu.test.tsx`
- Modify: `src/features/graph/Canvas.tsx`, `src/features/graph/Canvas.test.tsx`, `src/features/table/TableView.tsx`, `src/features/table/TableView.test.tsx`, `src/features/details/DetailsPanel.tsx`, `src/features/details/DetailsPanel.test.tsx`, `src/App.tsx`

- [ ] **Step 1: Write the failing tests**

`src/features/actions/ActionsMenu.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { ActionsMenu } from "./ActionsMenu";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const open = (nodeId: string) => useAppStore.setState({ actionsMenu: { nodeId, x: 40, y: 60 } });
const items = () => screen.getAllByRole("menuitem").map((b) => b.textContent);

beforeEach(() => useAppStore.setState(initialState()));

describe("ActionsMenu", () => {
  it("renders nothing while closed", () => {
    render(<ActionsMenu />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("lists the actions for the kind and focuses the first", () => {
    open("Deployment/p/web");
    render(<ActionsMenu />);
    expect(items()).toEqual(["Scale…", "Restart", "Rollback…", "Delete…"]);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Scale…" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Restart" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete…" }));
  });

  it("offers only Delete for kinds without rollout actions", () => {
    open("PodGroup/p/Deployment/web");
    render(<ActionsMenu />);
    expect(items()).toEqual(["Delete…"]);
  });

  it("Scale and Restart open their dialogs; Rollback asks for the History tab; Delete asks to delete", () => {
    open("Deployment/p/web");
    const { rerender } = render(<ActionsMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Scale…" }));
    expect(useAppStore.getState().actionDialog).toEqual({ type: "scale", nodeId: "Deployment/p/web" });
    expect(useAppStore.getState().actionsMenu).toBeNull();
    open("Deployment/p/web");
    rerender(<ActionsMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart" }));
    expect(useAppStore.getState().actionDialog).toEqual({ type: "restart", nodeId: "Deployment/p/web" });
    open("Deployment/p/web");
    rerender(<ActionsMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rollback…" }));
    expect(useAppStore.getState().requestedTab).toBe("history");
    open("Deployment/p/web");
    rerender(<ActionsMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(useAppStore.getState().deleteDialog).toEqual({ open: true, nodeId: "Deployment/p/web" });
  });

  it("a click outside closes it", () => {
    open("Deployment/p/web");
    render(<ActionsMenu />);
    fireEvent.mouseDown(screen.getByTestId("actions-backdrop"));
    expect(useAppStore.getState().actionsMenu).toBeNull();
  });
});
```

Append to `src/features/graph/Canvas.test.tsx` inside `describe("Canvas", …)`:

```tsx
  it("right-clicking a node opens the Actions menu for it", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [{ id: "Deployment/p/web", kind: "Deployment", namespace: "p", name: "web", status: "ok", badges: ["1/1"], group: null }], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "p" },
    });
    render(<Canvas />);
    fireEvent.contextMenu(screen.getByText("web"), { clientX: 120, clientY: 80 });
    expect(useAppStore.getState().actionsMenu).toEqual({ nodeId: "Deployment/p/web", x: 120, y: 80 });
  });
```

(add `fireEvent` to the `@testing-library/react` import at the top of that file).

Append to `src/features/table/TableView.test.tsx` inside `describe("TableView", …)`:

```tsx
  it("right-clicking a row opens the Actions menu for it", () => {
    render(<TableView />);
    fireEvent.contextMenu(screen.getByText("db"), { clientX: 30, clientY: 40 });
    expect(useAppStore.getState().actionsMenu).toEqual({ nodeId: "Pod/payments/db", x: 30, y: 40 });
  });
```

Append to `src/features/details/DetailsPanel.test.tsx` inside `describe("DetailsPanel", …)`:

```tsx
  it("the Actions button opens the menu for the selection", () => {
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(useAppStore.getState().actionsMenu).toMatchObject({ nodeId: "Pod/p/web-1" });
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `rtk proxy pnpm vitest run src/features/actions src/features/graph/Canvas.test.tsx src/features/table/TableView.test.tsx src/features/details/DetailsPanel.test.tsx`
Expected: FAIL — `./ActionsMenu` not found; no menu opens on right-click; no Actions button.

- [ ] **Step 3: Implement the menu**

`src/features/actions/ActionsMenu.tsx`:

```tsx
import { useEffect, useRef, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { actionsFor, kindOf, type ActionId } from "./actionKinds";

const LABEL: Record<ActionId, string> = { scale: "Scale…", restart: "Restart", rollback: "Rollback…", delete: "Delete…" };
const WIDTH = 200;

/** The Actions menu, opened from the details header or by right-clicking a node or a table row.
 *  Escape closes it from `useGlobalKeys`. */
export function ActionsMenu() {
  const { menu, close, openActionDialog, requestDelete, requestTab } = useAppStore(useShallow((s) => ({
    menu: s.actionsMenu, close: s.closeActionsMenu, openActionDialog: s.openActionDialog, requestDelete: s.requestDelete, requestTab: s.requestTab,
  })));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, [menu]);
  if (!menu) return null;

  const items = actionsFor(kindOf(menu.nodeId));
  const run = (id: ActionId) => {
    close();
    if (id === "scale" || id === "restart") openActionDialog({ type: id, nodeId: menu.nodeId });
    else if (id === "rollback") requestTab("history");
    else requestDelete(menu.nodeId);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1) + all.length) % all.length]?.focus();
  };
  // Keep the menu on screen when it opens near the right edge.
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - WIDTH - 8));

  return (
    <div data-testid="actions-backdrop" className="fixed inset-0 z-30"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div ref={ref} role="menu" aria-label="Actions" onKeyDown={onKeyDown} style={{ left, top: menu.y, width: WIDTH }}
        className="absolute rounded-xl border border-border bg-elevated py-1 text-sm">
        {items.map((id) => (
          <div key={id}>
            {id === "delete" && items.length > 1 && <div role="separator" className="my-1 border-t border-border" />}
            <button type="button" role="menuitem" onClick={() => run(id)}
              className={`block w-full px-3 py-1.5 text-left outline-none hover:bg-surface focus-visible:bg-surface ${id === "delete" ? "text-status-err" : "text-text-hi"}`}>
              {LABEL[id]}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the right-clicks, the header button and the mount point**

`src/features/graph/Canvas.tsx`: add `openActionsMenu: s.openActionsMenu,` to the `useShallow` selector, add after `onNodeDoubleClick`:

```tsx
  const onNodeContextMenu = useCallback<NodeMouseHandler<ResourceFlowNode>>((e, node) => {
    e.preventDefault();
    s.openActionsMenu(node.id, e.clientX, e.clientY);
  }, [s.openActionsMenu]);
```

and pass `onNodeContextMenu={onNodeContextMenu}` to `<ReactFlow>` after `onNodeDoubleClick`.

`src/features/table/TableView.tsx`: add `openActionsMenu: s.openActionsMenu,` to the selector (and to the destructured names), pass a handler to `Row`:

```tsx
              <Row key={r.nodeId} row={r} columns={table.columns} selected={r.nodeId === selectedId}
                onClick={() => void select(r.nodeId)} onDoubleClick={() => void focusInGraph(r.nodeId)}
                onContextMenu={(e) => { e.preventDefault(); openActionsMenu(r.nodeId, e.clientX, e.clientY); }} />
```

and change `Row`'s signature and `<tr>`:

```tsx
function Row({ row, columns, selected, onClick, onDoubleClick, onContextMenu }: {
  row: TableRow; columns: TableColumn[]; selected: boolean; onClick: () => void; onDoubleClick: () => void; onContextMenu: (e: MouseEvent) => void;
}) {
  return (
    <tr aria-selected={selected} onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} title="Double-click to show in graph"
```

with `type MouseEvent` added to the `react` import (`import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";`).

`src/features/details/DetailsPanel.tsx`: import `ChevronDown` from `lucide-react` (`import { ChevronDown, Maximize2, Minimize2, Trash2 } from "lucide-react";`), add `openActionsMenu: s.openActionsMenu,` to the selector at the top of `DetailsPanel` (and destructure it), and insert before the trash button:

```tsx
        {selectedId && (
          <button type="button" aria-label="Actions" aria-haspopup="menu"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openActionsMenu(selectedId, r.left, r.bottom + 4); }}
            className="flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-text-muted hover:bg-surface hover:text-text-hi">
            Actions <ChevronDown className="size-4" />
          </button>
        )}
```

`src/App.tsx`: import `ActionsMenu` from `./features/actions/ActionsMenu` and add before `<Toasts />`:

```tsx
      <ActionsMenu />
```

- [ ] **Step 5: Run the tests**

Run: `rtk proxy pnpm vitest run && rtk proxy pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/actions src/features/graph/Canvas.tsx src/features/graph/Canvas.test.tsx src/features/table src/features/details/DetailsPanel.tsx src/features/details/DetailsPanel.test.tsx src/App.tsx
git commit -m "$(cat <<'EOF'
Add the Actions menu to the details header, graph nodes and table rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Scale, Restart and Rollback dialogs

**Files:**
- Create: `src/features/actions/ActionDialogs.tsx`, `src/features/actions/ActionDialogs.test.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing tests**

`src/features/actions/ActionDialogs.test.tsx`:

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import type { GraphEdge, GraphNode } from "../../shared/ipc/types";
import { ActionDialogs } from "./ActionDialogs";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const WEB = "Deployment/p/web";
const web: GraphNode = { id: WEB, kind: "Deployment", namespace: "p", name: "web", status: "ok", badges: ["3/3", "nginx:1.27"], group: null };
const hpa: GraphNode = { id: "HorizontalPodAutoscaler/p/web-hpa", kind: "HorizontalPodAutoscaler", namespace: "p", name: "web-hpa", status: "ok", badges: ["2–10", "3"], group: null };
const scales: GraphEdge = { id: "e", source: hpa.id, target: WEB, relation: "scales" };

beforeEach(() => useAppStore.setState(applySnapshot(initialState(), { nodes: [web], edges: [] })));

describe("ScaleDialog", () => {
  it("starts from the desired replicas and applies the new count", () => {
    const scaleObject = vi.fn(async () => {});
    useAppStore.setState({ scaleObject, actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    const dialog = screen.getByRole("dialog", { name: "Scale Deployment web" });
    const input = within(dialog).getByRole("spinbutton", { name: "Replicas" });
    expect(input).toHaveValue(3);
    fireEvent.click(within(dialog).getByRole("button", { name: "Increase replicas" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Increase replicas" }));
    expect(input).toHaveValue(5);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(scaleObject).toHaveBeenCalledWith(WEB, 5);
  });

  it("refuses counts outside 0 … 10000", () => {
    useAppStore.setState({ actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    const input = screen.getByRole("spinbutton", { name: "Replicas" });
    for (const bad of ["-1", "10001", "1.5", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("warns when an HPA manages the workload but still allows the scale", () => {
    useAppStore.setState({ ...applySnapshot(initialState(), { nodes: [web, hpa], edges: [scales] }), actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    expect(screen.getByRole("note")).toHaveTextContent("Managed by HPA web-hpa (min 2, max 10), which will override this value.");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("Cancel closes without scaling", () => {
    const scaleObject = vi.fn(async () => {});
    useAppStore.setState({ scaleObject, actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().actionDialog).toBeNull();
    expect(scaleObject).not.toHaveBeenCalled();
  });
});

describe("Restart and Rollback confirmations", () => {
  it("Restart confirms, then restarts", () => {
    const restartObject = vi.fn(async () => {});
    useAppStore.setState({ restartObject, actionDialog: { type: "restart", nodeId: WEB } });
    render(<ActionDialogs />);
    const dialog = screen.getByRole("alertdialog", { name: "Restart Deployment web?" });
    expect(dialog).toHaveTextContent("Its pods are replaced according to the rollout strategy.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    expect(restartObject).toHaveBeenCalledWith(WEB);
  });

  it("Rollback names the revision, then rolls back", () => {
    const rollbackObject = vi.fn(async () => {});
    useAppStore.setState({ rollbackObject, actionDialog: { type: "rollback", nodeId: WEB, revision: 2 } });
    render(<ActionDialogs />);
    const dialog = screen.getByRole("alertdialog", { name: "Roll Deployment web back to revision 2?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rollback" }));
    expect(rollbackObject).toHaveBeenCalledWith(WEB, 2);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `rtk proxy pnpm vitest run src/features/actions/ActionDialogs.test.tsx`
Expected: FAIL — `./ActionDialogs` not found.

- [ ] **Step 3: Implement**

`src/features/actions/ActionDialogs.tsx`:

```tsx
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { NodeId } from "../../shared/ipc/types";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { describeId, desiredReplicas, hpaFor, MAX_REPLICAS } from "./actionKinds";

/** Whichever action dialog the store has open. Escape closes it from `useGlobalKeys`. */
export function ActionDialogs() {
  const dialog = useAppStore((s) => s.actionDialog);
  if (!dialog) return null;
  if (dialog.type === "scale") return <ScaleDialog nodeId={dialog.nodeId} />;
  if (dialog.type === "restart") return <RestartDialog nodeId={dialog.nodeId} />;
  return <RollbackDialog nodeId={dialog.nodeId} revision={dialog.revision} />;
}

function ScaleDialog({ nodeId }: { nodeId: NodeId }) {
  const { nodes, edges, scaleObject, close, busy } = useAppStore(useShallow((s) => ({
    nodes: s.nodes, edges: s.edges, scaleObject: s.scaleObject, close: s.closeActionDialog, busy: s.actionBusy,
  })));
  const hpa = useMemo(() => hpaFor(nodeId, edges.values(), nodes), [nodeId, edges, nodes]);
  // Seeded once: later graph updates must not overwrite what the user is typing.
  const [value, setValue] = useState(() => String(desiredReplicas(nodes.get(nodeId))));
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.select(); }, []);

  const n = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= MAX_REPLICAS;
  const step = (d: number) => setValue(String(Math.min(MAX_REPLICAS, Math.max(0, (Number.isInteger(n) ? n : 0) + d))));

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80">
      <form role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-[440px] rounded-card border border-border bg-elevated p-8"
        onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void scaleObject(nodeId, n); }}>
        <h2 id={titleId} className="mb-4 text-2xl font-semibold leading-[1.33] text-text-hi">Scale {describeId(nodeId)}</h2>
        {hpa && (
          <p role="note" className="mb-4 rounded-xl border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-sm text-status-warn">
            Managed by HPA {hpa.name}{hpa.min !== null ? ` (min ${hpa.min}, max ${hpa.max})` : ""}, which will override this value.
          </p>
        )}
        <div className="mb-6 flex items-center gap-2 text-sm text-text-dim">
          <span className="mr-2">Replicas</span>
          <Button aria-label="Decrease replicas" onClick={() => step(-1)}>−</Button>
          <input ref={inputRef} type="number" aria-label="Replicas" min={0} max={MAX_REPLICAS} step={1} value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24 rounded-xl border border-border-strong bg-transparent px-3 py-1.5 text-text-hi tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-accent" />
          <Button aria-label="Increase replicas" onClick={() => step(1)}>+</Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>Apply</Button>
        </div>
      </form>
    </div>
  );
}

function RestartDialog({ nodeId }: { nodeId: NodeId }) {
  const { restartObject, close } = useAppStore(useShallow((s) => ({ restartObject: s.restartObject, close: s.closeActionDialog })));
  return (
    <ConfirmDialog open title={`Restart ${describeId(nodeId)}?`} body="Its pods are replaced according to the rollout strategy."
      confirmLabel="Restart" onConfirm={() => void restartObject(nodeId)} onCancel={close} />
  );
}

function RollbackDialog({ nodeId, revision }: { nodeId: NodeId; revision: number }) {
  const { rollbackObject, close } = useAppStore(useShallow((s) => ({ rollbackObject: s.rollbackObject, close: s.closeActionDialog })));
  return (
    <ConfirmDialog open title={`Roll ${describeId(nodeId)} back to revision ${revision}?`}
      body="The pod template of that revision is applied and a rollout starts." confirmLabel="Rollback"
      onConfirm={() => void rollbackObject(nodeId, revision)} onCancel={close} />
  );
}
```

In `src/App.tsx` import `ActionDialogs` from `./features/actions/ActionDialogs` and add after `<ErrorBoundary name="create dialog">…</ErrorBoundary>`:

```tsx
      <ErrorBoundary name="action dialogs"><ActionDialogs /></ErrorBoundary>
```

- [ ] **Step 4: Run the tests**

Run: `rtk proxy pnpm vitest run && rtk proxy pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/actions/ActionDialogs.tsx src/features/actions/ActionDialogs.test.tsx src/App.tsx
git commit -m "$(cat <<'EOF'
Add the Scale, Restart and Rollback dialogs, with an HPA warning on Scale

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: History tab

**Files:**
- Create: `src/features/details/HistoryTab.tsx`, `src/features/details/HistoryTab.test.tsx`
- Modify: `src/features/details/DetailsPanel.tsx`, `src/features/details/DetailsPanel.test.tsx`

- [ ] **Step 1: Write the failing tests**

`src/features/details/HistoryTab.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import type { GraphNode, Revision } from "../../shared/ipc/types";
import { HistoryTab } from "./HistoryTab";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const WEB = "Deployment/p/web";
const web: GraphNode = { id: WEB, kind: "Deployment", namespace: "p", name: "web", status: "ok", badges: ["3/3"], group: null };
const REVISIONS: Revision[] = [
  { revision: 2, current: true, createdAt: "2026-10-05T10:00:00Z", changeCause: null, images: ["web:2"], template: "image: web:2\n" },
  { revision: 1, current: false, createdAt: "2026-10-01T10:00:00Z", changeCause: "first release", images: ["web:1"], template: "image: web:1\n" },
];
const historyCalls = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "rollout_history").length;

beforeEach(() => {
  useAppStore.setState(applySnapshot(initialState(), { nodes: [web], edges: [] }));
  vi.mocked(invoke).mockReset().mockImplementation(async (cmd: string) => (cmd === "rollout_history" ? REVISIONS : null));
});

describe("HistoryTab", () => {
  it("lists revisions newest first, the current one marked and not pickable", async () => {
    render(<HistoryTab nodeId={WEB} />);
    expect(await screen.findByText("#2")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("rollout_history", { nodeId: WEB });
    expect(screen.getByText("current")).toBeInTheDocument();
    expect(screen.getByText("first release")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /#2/ })).toBeDisabled();
    expect(screen.getByText(/pick a revision/i)).toBeInTheDocument();
  });

  it("picking a revision shows its diff against the current one and offers the rollback", async () => {
    render(<HistoryTab nodeId={WEB} />);
    fireEvent.click(await screen.findByRole("button", { name: /#1/ }));
    expect(screen.getByText("- image: web:2")).toBeInTheDocument();
    expect(screen.getByText("+ image: web:1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rollback to 1" }));
    expect(useAppStore.getState().actionDialog).toEqual({ type: "rollback", nodeId: WEB, revision: 1 });
  });

  it("says so when the role cannot read the history", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "rollout_history") throw { kind: "forbidden", message: "controllerrevisions is forbidden" };
      return null;
    });
    render(<HistoryTab nodeId={WEB} />);
    expect(await screen.findByText("No permission to read revision history (controllerrevisions).")).toBeInTheDocument();
  });

  it("refetches when the workload changes, at most once a second", async () => {
    render(<HistoryTab nodeId={WEB} />);
    await screen.findByText("#2");
    expect(historyCalls()).toBe(1);
    act(() => useAppStore.getState().applyDelta({ addedNodes: [], updatedNodes: [{ ...web, badges: ["2/3"] }], removedNodes: [], addedEdges: [], removedEdges: [] }));
    await waitFor(() => expect(historyCalls()).toBe(2), { timeout: 2500 });
  });
});
```

Append to `src/features/details/DetailsPanel.test.tsx` inside `describe("DetailsPanel", …)`:

```tsx
  it("offers a History tab for rollout kinds only, and opens it on request", () => {
    const historyTab = () => screen.queryByRole("tab", { name: "History" });
    const { unmount } = render(<DetailsPanel />);
    expect(historyTab()).not.toBeInTheDocument(); // a Pod
    unmount();
    const dep = { ...node, id: "Deployment/p/web", kind: "Deployment" as const, name: "web" };
    useAppStore.setState((s) => ({ nodes: new Map([...s.nodes, [dep.id, dep]]), selectedId: dep.id, details: { ...s.details!, nodeId: dep.id }, requestedTab: "history" }));
    render(<DetailsPanel />);
    expect(historyTab()).toHaveAttribute("aria-selected", "true");
    expect(useAppStore.getState().requestedTab).toBeNull();
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `rtk proxy pnpm vitest run src/features/details`
Expected: FAIL — `./HistoryTab` not found; no History tab.

- [ ] **Step 3: Implement the tab**

`src/features/details/HistoryTab.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type AppError, type NodeId, type Revision } from "../../shared/ipc/types";
import { Button } from "../../shared/ui/Button";
import { age } from "../actions/age";
import { DiffView } from "../editor/DiffView";

/** At most one refetch per second while a rollout keeps changing the workload. */
const REFRESH_MS = 1000;

function Message({ text }: { text: string }) {
  return <div className="grid h-full place-items-center text-sm text-text-muted">{text}</div>;
}

/** A workload's revisions; picking one shows its pod template diff and offers a rollback to it. */
export function HistoryTab({ nodeId }: { nodeId: NodeId }) {
  const { node, openActionDialog } = useAppStore(useShallow((s) => ({ node: s.nodes.get(nodeId), openActionDialog: s.openActionDialog })));
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const lastLoad = useRef(0);

  // `node` changes identity with every graph update of this workload (a rollout, a scale): refetch then.
  useEffect(() => {
    let active = true;
    const load = () => {
      lastLoad.current = Date.now();
      commands.rolloutHistory(nodeId).then(
        (r) => { if (active) { setRevisions(r); setError(null); } },
        (e) => { if (active) setError(toAppError(e)); },
      );
    };
    const wait = REFRESH_MS - (Date.now() - lastLoad.current);
    if (wait <= 0) {
      load();
      return () => { active = false; };
    }
    const timer = setTimeout(load, wait);
    return () => { active = false; clearTimeout(timer); };
  }, [nodeId, node]);

  if (error?.kind === "forbidden") return <Message text="No permission to read revision history (controllerrevisions)." />;
  if (error) return <Message text={`Could not load the history: ${error.message}`} />;
  if (!revisions) return <Message text="Loading history…" />;
  if (revisions.length === 0) return <Message text="No revisions recorded." />;

  const current = revisions.find((r) => r.current) ?? revisions[0];
  const selected = revisions.find((r) => r.revision === picked && !r.current) ?? null;
  return (
    <div className="flex h-full min-h-0">
      <ul aria-label="Revisions" className="w-80 shrink-0 overflow-auto border-r border-border">
        {revisions.map((r) => (
          <li key={r.revision}>
            <button type="button" disabled={r.current} aria-pressed={r.revision === selected?.revision} onClick={() => setPicked(r.revision)}
              className={`w-full px-5 py-2.5 text-left text-sm disabled:cursor-default ${r.revision === selected?.revision ? "bg-muted/50" : "enabled:hover:bg-muted/25"}`}>
              <div className="flex items-center gap-2">
                <span className="font-medium text-text-hi">#{r.revision}</span>
                {r.current && <span className="rounded-full bg-accent/20 px-2 text-[10px] text-accent">current</span>}
                <span className="ml-auto text-xs text-text-muted">{age(r.createdAt)}</span>
              </div>
              <div className="truncate text-xs text-text">{r.images.join(", ")}</div>
              {r.changeCause && <div className="truncate text-xs text-text-muted">{r.changeCause}</div>}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
              <span className="text-xs text-text-muted">#{current.revision} (current) → #{selected.revision}</span>
              <Button variant="primary" onClick={() => openActionDialog({ type: "rollback", nodeId, revision: selected.revision })}>
                Rollback to {selected.revision}
              </Button>
            </div>
            <div className="min-h-0 flex-1"><DiffView original={current.template} next={selected.template} /></div>
          </>
        ) : (
          <Message text="Pick a revision to compare it with the current one." />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the tab to the details panel**

In `src/features/details/DetailsPanel.tsx`:

- import `type DetailsTab` from `../../app/store` (`import { useAppStore, type DetailsTab } from "../../app/store";`), `ROLLOUT_KINDS` from `../actions/actionKinds` and `HistoryTab` from `./HistoryTab`;
- replace `type Tab = "overview" | "yaml" | "events" | "logs";` with `type Tab = DetailsTab;`;
- add `requestedTab: s.requestedTab, consumeRequestedTab: s.consumeRequestedTab,` to the selector (and destructure them);
- right after `useEffect(() => { setTab("overview"); }, [details?.nodeId]);` add:

```tsx
  // A requested tab (Rollback… → History) wins over the reset above, which runs first in the same commit.
  useEffect(() => {
    if (!requestedTab || !details || details.nodeId !== selectedId) return;
    setTab(requestedTab);
    consumeRequestedTab();
  }, [requestedTab, details?.nodeId, selectedId, consumeRequestedTab]);
```

- after the Logs tab line add:

```tsx
  if (heading?.kind && ROLLOUT_KINDS.has(heading.kind)) tabs.push({ id: "history", label: "History" });
```

- in the content switch, replace `) : tab === "logs" ? (` … with:

```tsx
        ) : tab === "logs" ? (
          <LogsTab />
        ) : tab === "history" ? (
          <HistoryTab key={details.nodeId} nodeId={details.nodeId} />
        ) : (
```

(keeping the final `<EventsTab events={details.events} />` branch).

- [ ] **Step 5: Run the tests**

Run: `rtk proxy pnpm vitest run && rtk proxy pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/details
git commit -m "$(cat <<'EOF'
Add the History tab with revision diffs and rollback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: README, full checks, live check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature**

In `README.md`, after the paragraph that starts `**+ Create** in the header …`, add:

```markdown
**Rollout actions.** **Actions ▾** in the details panel, or a right-click on a graph node or a table row, opens the actions for the object:
- **Scale…** (Deployments, StatefulSets) sets the replica count. When a HorizontalPodAutoscaler manages the workload, the dialog says it will override the value.
- **Restart** (Deployments, StatefulSets, DaemonSets) replaces the pods the way `kubectl rollout restart` does.
- **Rollback…** opens the **History** tab: pick a revision to see its pod template diff, then roll back to it.

While a rollout runs the node shows `rolling updated/desired`; a Deployment that misses its progress deadline turns red and Overview shows why.
```

- [ ] **Step 2: Run every check CI runs**

```bash
rtk proxy pnpm typecheck
rtk proxy pnpm test
cd src-tauri
rtk proxy cargo fmt --check
rtk proxy cargo clippy --all-targets -- -D warnings
rtk proxy cargo test
```

Expected: all green. Fix anything `cargo fmt --check` reports with `cargo fmt` and re-run.

- [ ] **Step 3: Live check in the app**

Run `examples/demo/setup.sh` (docker-desktop), then `pnpm tauri dev`, open namespace `shop` and check:
1. Right-click the `workers` Deployment node → Actions menu at the pointer; Esc closes it.
2. **Scale…** → 2 → Apply: toast "Scaled Deployment workers to 2", the node badge becomes `2/2`.
3. **Restart**: toast, the node shows `rolling …` and goes back to green.
4. **Rollback…** → History tab lists 2 revisions; pick #1 → diff shows the `restartedAt` line removed → Rollback to 1 → confirm → toast.
5. A Deployment with an HPA: the Scale dialog shows the HPA warning.
6. Switch to the `wiring-viewer` context: History says "No permission to read revision history (controllerrevisions)." for a StatefulSet (if that role cannot list them), Scale/Restart fail with a forbidden toast.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Document the rollout actions in the README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Deviations from the spec

1. **HPA min/max come from the HPA node's badge, not `get_object`.** `graph/status.rs` already renders an HPA's first badge as `min–max` (`hpa()`), so `hpaFor` reads it from the graph; no extra IPC call when the dialog opens. If the HPA node is hidden, the warning shows the name only (as the spec allows when the lookup fails).
2. **Rollback confirmation has no diff.** `ConfirmDialog` takes a plain string body, and the diff is already on screen in the History tab where the rollback is started, so the confirmation is a plain `ConfirmDialog`. No `RollbackDialog`-with-`DiffView`.
3. **Deployment rollback uses a strategic merge patch with `$patch: replace`, not a JSON patch.** kube 4.2's `Patch::Json` needs the `jsonpatch` feature, which `Cargo.toml` does not enable; `$patch: replace` on `spec.template` gives the same result (the whole template replaced, as `kubectl rollout undo`) and is the same form StatefulSet/DaemonSet ControllerRevision data already uses.
4. **`Revision.createdAt` is `string | null`.** `metadata.creationTimestamp` is optional in the API types; a missing one serialises as `null` instead of an invented value.
5. **The rolling badge ignores missing status fields.** `updatedReplicas` / `observedGeneration` absent (older servers, the existing `statuses.yaml` fixtures) never count as rolling, so existing badges and tests stay unchanged.
6. **Toasts name the kind.** "Scaled Deployment web to 5" rather than "Scaled web to 5", matching the existing "Deleted Pod web-1" / "Saved …" toasts (`describeNode`).
7. **Current replicas for the Scale dialog come from the node's `ready/desired` badge** (`desiredReplicas`), falling back to 1; the frontend has no YAML parser and the badge is always present on Deployment/StatefulSet nodes.
8. **History refresh** is driven by the selected node object changing in the store (every `graph_delta` that updates it), throttled to once per second, rather than by inspecting `graph_delta` payloads directly.
9. **Smoke fixture gains a `db` StatefulSet** so the ControllerRevision path is exercised against a real API server.
