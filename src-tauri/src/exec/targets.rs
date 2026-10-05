//! Which running pods and containers a node id offers a terminal for (spec §3 "Open").
//! Pure: reads only the in-memory `Store`.

use k8s_openapi::api::core::v1::Pod;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::build::{group_members, is_owned_by, OWNER_CHAIN_DEPTH};
use crate::session::parse_node_id;
use crate::store::{Kind, Object, Store};

use super::ExecPod;

/// A pod that can run `exec`: Running and not being deleted.
fn running(p: &Pod) -> bool {
    p.metadata.deletion_timestamp.is_none() && p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running")
}

/// The running pods `node_id` stands for, in pod-name order, each with its regular containers.
/// Kinds that run no pods are `invalid`; a Pod that is not in the store is `notFound`.
pub fn exec_pods(store: &Store, node_id: &str) -> AppResult<Vec<ExecPod>> {
    let (kind, ns, name) = parse_node_id(node_id)?;
    let objects: Vec<&Object> = match kind {
        Kind::Pod => vec![store
            .find(Kind::Pod, ns.as_deref(), &name)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in store")))?],
        Kind::PodGroup => group_members(store, node_id).iter().filter_map(|key| store.get(key)).collect(),
        Kind::Deployment | Kind::StatefulSet | Kind::DaemonSet | Kind::Job => store
            .iter_kind(Kind::Pod)
            .filter(|pod| pod.namespace() == ns.as_deref())
            .filter(|pod| is_owned_by(store, pod, kind, &name, OWNER_CHAIN_DEPTH))
            .collect(),
        other => {
            return Err(AppError::new(
                ErrorKind::Invalid,
                format!("{} has no containers to open a terminal in", other.as_str()),
            ))
        }
    };
    let mut pods: Vec<ExecPod> = objects
        .into_iter()
        .filter_map(|obj| {
            let Object::Pod(p) = obj else { return None };
            if !running(p) {
                return None;
            }
            let containers: Vec<String> = p.spec.as_ref()?.containers.iter().map(|c| c.name.clone()).collect();
            (!containers.is_empty()).then(|| ExecPod {
                name: obj.name().to_string(),
                containers,
            })
        })
        .collect();
    pods.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(pods)
}

/// Check a start request against what `exec_pods` offers; returns the namespace to exec in.
pub fn check_target(store: &Store, node_id: &str, pod: &str, container: &str) -> AppResult<String> {
    let (_, ns, _) = parse_node_id(node_id)?;
    let pods = exec_pods(store, node_id)?;
    let Some(found) = pods.iter().find(|p| p.name == pod) else {
        return Err(AppError::new(
            ErrorKind::Invalid,
            format!("pod {pod} is not running or does not belong to {node_id}"),
        ));
    };
    if !found.containers.iter().any(|c| c == container) {
        return Err(AppError::new(
            ErrorKind::NotFound,
            format!("pod {pod} has no container \"{container}\""),
        ));
    }
    ns.ok_or_else(|| AppError::new(ErrorKind::Invalid, format!("{node_id} has no namespace")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    fn store() -> Store {
        Store::from_fixture("exec").unwrap()
    }

    fn names(pods: &[ExecPod]) -> Vec<&str> {
        pods.iter().map(|p| p.name.as_str()).collect()
    }

    #[test]
    fn a_workload_offers_its_running_pods_in_name_order_without_init_containers() {
        let pods = exec_pods(&store(), "Deployment/shop/web").unwrap();
        assert_eq!(
            names(&pods),
            vec!["web-7f9c-a", "web-7f9c-b"],
            "pending and terminating pods are left out"
        );
        assert_eq!(pods[0].containers, vec!["app", "sidecar"]);
    }

    #[test]
    fn a_pod_offers_itself_when_running() {
        let pods = exec_pods(&store(), "Pod/shop/solo").unwrap();
        assert_eq!(
            pods,
            vec![ExecPod {
                name: "solo".into(),
                containers: vec!["main".into()]
            }]
        );
        assert!(
            exec_pods(&store(), "Pod/shop/web-7f9c-c").unwrap().is_empty(),
            "a Pending pod offers nothing"
        );
    }

    #[test]
    fn unknown_pods_and_kinds_without_containers_are_rejected() {
        assert_eq!(exec_pods(&store(), "Pod/shop/ghost").unwrap_err().kind, ErrorKind::NotFound);
        assert_eq!(exec_pods(&store(), "ConfigMap/shop/cfg").unwrap_err().kind, ErrorKind::Invalid);
    }

    #[test]
    fn a_start_request_must_name_an_offered_pod_and_container() {
        let s = store();
        assert_eq!(check_target(&s, "Deployment/shop/web", "web-7f9c-b", "sidecar").unwrap(), "shop");
        assert_eq!(
            check_target(&s, "Deployment/shop/web", "solo", "main").unwrap_err().kind,
            ErrorKind::Invalid
        );
        assert_eq!(
            check_target(&s, "Deployment/shop/web", "web-7f9c-c", "app").unwrap_err().kind,
            ErrorKind::Invalid
        );
        assert_eq!(
            check_target(&s, "Deployment/shop/web", "web-7f9c-a", "migrate").unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            check_target(&s, "Deployment/shop/web", "web-7f9c-a", "nope").unwrap_err().kind,
            ErrorKind::NotFound
        );
    }
}
