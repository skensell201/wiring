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
