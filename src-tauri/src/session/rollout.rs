//! Rollout actions (spec 2026-10-05): which kinds take which action, the patch bodies
//! (kubectl semantics) and revision history. Everything above the `impl Session` block is pure.

use k8s_openapi::api::apps::v1::{ControllerRevision, Deployment, ReplicaSet};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::store::{Kind, Object, Store};

/// Upper bound for a manual scale; anything larger is a typo, not an intent.
pub const MAX_REPLICAS: i64 = 10_000;
const RESTARTED_AT_ANNOTATION: &str = "kubectl.kubernetes.io/restartedAt";
const REVISION_ANNOTATION: &str = "deployment.kubernetes.io/revision";
const CHANGE_CAUSE_ANNOTATION: &str = "kubernetes.io/change-cause";
const POD_TEMPLATE_HASH: &str = "pod-template-hash";

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
    let Some(uid) = deployment.metadata.uid.as_deref() else {
        return Vec::new();
    };
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
    entries.sort_by_key(|e| std::cmp::Reverse(e.revision.revision));
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
    owned.sort_by_key(|cr| std::cmp::Reverse(cr.revision));
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
        assert!(
            entries[0].revision.template.contains("image: pg:17"),
            "{}",
            entries[0].revision.template
        );
        assert_eq!(entries[0].revision.images, vec!["pg:17".to_string()]);
        assert_eq!(entries[0].revision.created_at.as_deref(), Some("2026-10-03T10:00:00Z"));
        assert_eq!(
            entries[0].rollback,
            list[1].data.as_ref().unwrap().0,
            "the revision's data is the patch"
        );
        // DaemonSets report no update revision, and a stale one is unknown: the newest is current.
        assert_eq!(numbers(&controller_history("sts-db", None, &list)), vec![(2, true), (1, false)]);
        assert_eq!(
            numbers(&controller_history("sts-db", Some("gone"), &list)),
            vec![(2, true), (1, false)]
        );
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
}
