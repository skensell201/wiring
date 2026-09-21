//! Which `(pod, container)` pairs a node id stands for (spec §4 "Targets"). Pure: reads only
//! the in-memory `Store`, so it is unit-tested on the YAML fixtures.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::build::{group_members, is_owned_by, OWNER_CHAIN_DEPTH};
use crate::session::parse_node_id;
use crate::store::{Kind, Object, Store};

use super::LogTarget;

/// Every container of every pod `node_id` stands for, in pod-name order and, within a pod,
/// init containers first in spec order. `container = Some(name)` keeps only that container.
/// Kinds that do not run pods are `invalid`; a Pod that is not in the store is `notFound`.
pub fn targets(store: &Store, node_id: &str, container: Option<&str>) -> AppResult<Vec<LogTarget>> {
    let (kind, ns, name) = parse_node_id(node_id)?;
    let pods: Vec<&Object> = match kind {
        Kind::Pod => {
            let pod = store
                .find(Kind::Pod, ns.as_deref(), &name)
                .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in store")))?;
            vec![pod]
        }
        Kind::PodGroup => group_members(store, node_id).iter().filter_map(|key| store.get(key)).collect(),
        Kind::Deployment | Kind::StatefulSet | Kind::DaemonSet | Kind::Job | Kind::CronJob => {
            let mut pods: Vec<&Object> = store
                .iter_kind(Kind::Pod)
                .filter(|pod| pod.namespace() == ns.as_deref())
                .filter(|pod| is_owned_by(store, pod, kind, &name, OWNER_CHAIN_DEPTH))
                .collect();
            pods.sort_by(|a, b| a.name().cmp(b.name()));
            pods
        }
        other => return Err(AppError::new(ErrorKind::Invalid, format!("{} has no logs", other.as_str()))),
    };
    let mut out = Vec::new();
    for pod in pods {
        let Object::Pod(p) = pod else { continue };
        let Some(spec) = p.spec.as_ref() else { continue };
        let namespace = pod.namespace().unwrap_or_default().to_string();
        let init = spec.init_containers.iter().flatten().map(|c| (c.name.clone(), true));
        let main = spec.containers.iter().map(|c| (c.name.clone(), false));
        for (c, is_init) in init.chain(main) {
            if container.is_some_and(|want| want != c) {
                continue;
            }
            out.push(LogTarget {
                namespace: namespace.clone(),
                pod: pod.name().to_string(),
                container: c,
                init: is_init,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(t: &[LogTarget]) -> Vec<String> {
        t.iter()
            .map(|t| format!("{}/{}{}", t.pod, t.container, if t.init { " (init)" } else { "" }))
            .collect()
    }

    #[test]
    fn pod_lists_init_containers_first_then_containers_in_spec_order() {
        let store = Store::from_yaml_docs(
            "apiVersion: v1\nkind: Pod\nmetadata: { name: p, namespace: n }\nspec:\n  initContainers: [ { name: setup, image: busybox } ]\n  containers: [ { name: app, image: app }, { name: sidecar, image: envoy } ]\n",
        )
        .unwrap();
        let t = targets(&store, "Pod/n/p", None).unwrap();
        assert_eq!(names(&t), ["p/setup (init)", "p/app", "p/sidecar"]);
        assert_eq!(t[0].namespace, "n");
    }

    #[test]
    fn container_filter_keeps_only_that_name() {
        let store = Store::from_yaml_docs(
            "apiVersion: v1\nkind: Pod\nmetadata: { name: p, namespace: n }\nspec:\n  containers: [ { name: app, image: app }, { name: sidecar, image: envoy } ]\n",
        )
        .unwrap();
        assert_eq!(names(&targets(&store, "Pod/n/p", Some("sidecar")).unwrap()), ["p/sidecar"]);
        assert!(targets(&store, "Pod/n/p", Some("nope")).unwrap().is_empty());
    }

    #[test]
    fn deployment_and_podgroup_follow_the_owner_chain_through_the_replicaset() {
        let store = Store::from_fixture("podgroup").unwrap();
        let via_deployment = targets(&store, "Deployment/g/api", None).unwrap();
        let via_group = targets(&store, "PodGroup/g/Deployment/api", None).unwrap();
        assert_eq!(via_deployment.len(), 7, "{:?}", names(&via_deployment));
        assert_eq!(names(&via_deployment), names(&via_group));
        let pods: Vec<&String> = via_deployment.iter().map(|t| &t.pod).collect();
        let mut sorted = pods.clone();
        sorted.sort();
        assert_eq!(pods, sorted, "pods are in name order");
    }

    #[test]
    fn a_same_named_deployment_in_another_namespace_does_not_claim_pods() {
        // Two `web` Deployments; only the pod whose owner chain lives in `a` belongs to `a/web`.
        let store = Store::from_yaml_docs(
            "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web, namespace: a }\n---\n\
             apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web, namespace: b }\n---\n\
             apiVersion: apps/v1\nkind: ReplicaSet\nmetadata: { name: web-1, namespace: a, ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: web, uid: u1 } ] }\n---\n\
             apiVersion: apps/v1\nkind: ReplicaSet\nmetadata: { name: web-1, namespace: b, ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: web, uid: u2 } ] }\n---\n\
             apiVersion: v1\nkind: Pod\nmetadata: { name: web-1-a, namespace: a, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: web-1, uid: r1 } ] }\nspec: { containers: [ { name: c, image: web } ] }\n---\n\
             apiVersion: v1\nkind: Pod\nmetadata: { name: web-1-b, namespace: b, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: web-1, uid: r2 } ] }\nspec: { containers: [ { name: c, image: web } ] }\n",
        )
        .unwrap();
        assert_eq!(names(&targets(&store, "Deployment/a/web", None).unwrap()), ["web-1-a/c"]);
        assert_eq!(names(&targets(&store, "Deployment/b/web", None).unwrap()), ["web-1-b/c"]);
    }

    #[test]
    fn container_filter_also_selects_an_init_container_by_name() {
        let store = Store::from_yaml_docs(
            "apiVersion: v1\nkind: Pod\nmetadata: { name: p, namespace: n }\nspec:\n  initContainers: [ { name: setup, image: busybox } ]\n  containers: [ { name: app, image: app } ]\n",
        )
        .unwrap();
        let t = targets(&store, "Pod/n/p", Some("setup")).unwrap();
        assert_eq!(names(&t), ["p/setup (init)"]);
        assert!(t[0].init);
    }

    #[test]
    fn cronjob_reaches_pods_through_its_jobs() {
        let store = Store::from_fixture("relations").unwrap();
        assert_eq!(names(&targets(&store, "CronJob/r/nightly", None).unwrap()), ["nightly-1-x/c"]);
        assert_eq!(names(&targets(&store, "Job/r/nightly-1", None).unwrap()), ["nightly-1-x/c"]);
        // `web-1-a` in the fixture has an init container `init` and a main container `c`.
        assert_eq!(
            names(&targets(&store, "Deployment/r/web", None).unwrap()),
            ["web-1-a/init (init)", "web-1-a/c"]
        );
    }

    #[test]
    fn kinds_without_pods_are_invalid_and_a_missing_pod_is_not_found() {
        let store = Store::from_fixture("relations").unwrap();
        assert_eq!(targets(&store, "ConfigMap/r/web-cfg", None).unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(targets(&store, "Pod/r/ghost", None).unwrap_err().kind, ErrorKind::NotFound);
    }
}
