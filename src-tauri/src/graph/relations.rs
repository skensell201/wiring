//! Derive edges between objects in a Store. Every function only emits an edge
//! when both endpoints exist in the store.

use k8s_openapi::api::core::v1::PodSpec;
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicyPeer, NetworkPolicySpec};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use std::collections::BTreeMap;

use super::model::{node_id, Edge, Relation};
use super::selector::label_selector_matches;
use super::status::selector_matches;
use crate::store::{Kind, Object, Store};

fn id_of(obj: &Object) -> String {
    node_id(obj.kind(), obj.namespace(), obj.name())
}

/// Edge from `kind/name` in the same namespace as `to`, if that object exists.
fn edge_from_named(store: &Store, kind: Kind, ns: Option<&str>, name: &str, to: &Object, relation: Relation) -> Option<Edge> {
    let src = store.find(kind, ns, name)?;
    Some(Edge::new(id_of(src), id_of(to), relation))
}

/// owner -> child via metadata.ownerReferences (only watched owner kinds).
pub fn owner_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for child in store.iter() {
        let Some(refs) = child.meta().owner_references.as_ref() else {
            continue;
        };
        for r in refs {
            let Some(kind) = Kind::parse(&r.kind) else { continue };
            if let Some(e) = edge_from_named(store, kind, child.namespace(), &r.name, child, Relation::Owns) {
                edges.push(e);
            }
        }
    }
    edges
}

/// Service -> Pod when spec.selector matches pod labels.
pub fn service_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for svc in store.iter_kind(Kind::Service) {
        let Object::Service(s) = svc else { continue };
        let Some(selector) = s.spec.as_ref().and_then(|s| s.selector.as_ref()) else {
            continue;
        };
        for pod in store.iter_kind(Kind::Pod).filter(|p| p.namespace() == svc.namespace()) {
            if selector_matches(selector, pod.meta().labels.as_ref()) {
                edges.push(Edge::new(id_of(svc), id_of(pod), Relation::Selects));
            }
        }
    }
    edges
}

/// Every Service an Ingress routes to (default backend and rule paths), sorted and deduplicated.
pub fn ingress_backend_names(i: &Ingress) -> Vec<String> {
    let Some(spec) = i.spec.as_ref() else { return vec![] };
    let mut names: Vec<String> = vec![];
    if let Some(name) = spec
        .default_backend
        .as_ref()
        .and_then(|b| b.service.as_ref())
        .map(|s| s.name.clone())
    {
        names.push(name);
    }
    for rule in spec.rules.as_deref().unwrap_or_default() {
        for path in rule.http.as_ref().map(|h| h.paths.as_slice()).unwrap_or_default() {
            if let Some(svc) = path.backend.service.as_ref() {
                names.push(svc.name.clone());
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

/// Ingress -> Service via rules[].http.paths[].backend.service and defaultBackend.
pub fn ingress_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for ing in store.iter_kind(Kind::Ingress) {
        let Object::Ingress(i) = ing else { continue };
        for name in ingress_backend_names(i) {
            if let Some(svc) = store.find(Kind::Service, ing.namespace(), &name) {
                edges.push(Edge::new(id_of(ing), id_of(svc), Relation::Routes));
            }
        }
    }
    edges
}

/// Everything a pod consumes: ConfigMap/Secret (mounts, envFrom), PVC (claims), ServiceAccount (usesSA).
pub fn pod_input_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for pod in store.iter_kind(Kind::Pod) {
        let Object::Pod(p) = pod else { continue };
        let Some(spec) = p.spec.as_ref() else { continue };
        let ns = pod.namespace();
        let mut push = |kind: Kind, name: &str, relation: Relation| {
            if let Some(e) = edge_from_named(store, kind, ns, name, pod, relation) {
                edges.push(e);
            }
        };
        collect_pod_inputs(spec, &mut push);
    }
    edges.sort_by(|a, b| a.id.cmp(&b.id));
    edges.dedup_by(|a, b| a.id == b.id);
    edges
}

fn collect_pod_inputs(spec: &PodSpec, push: &mut impl FnMut(Kind, &str, Relation)) {
    for v in spec.volumes.as_deref().unwrap_or_default() {
        if let Some(cm) = v.config_map.as_ref().map(|c| c.name.as_str()) {
            push(Kind::ConfigMap, cm, Relation::Mounts);
        }
        if let Some(sec) = v.secret.as_ref().and_then(|s| s.secret_name.as_deref()) {
            push(Kind::Secret, sec, Relation::Mounts);
        }
        if let Some(pvc) = v.persistent_volume_claim.as_ref() {
            push(Kind::PersistentVolumeClaim, &pvc.claim_name, Relation::Claims);
        }
        for src in v.projected.as_ref().and_then(|p| p.sources.as_deref()).unwrap_or_default() {
            if let Some(cm) = src.config_map.as_ref().map(|c| c.name.as_str()) {
                push(Kind::ConfigMap, cm, Relation::Mounts);
            }
            if let Some(sec) = src.secret.as_ref().map(|s| s.name.as_str()) {
                push(Kind::Secret, sec, Relation::Mounts);
            }
        }
    }
    let containers = spec.containers.iter().chain(spec.init_containers.as_deref().unwrap_or_default());
    for c in containers {
        for ef in c.env_from.as_deref().unwrap_or_default() {
            if let Some(cm) = ef.config_map_ref.as_ref().map(|r| r.name.as_str()) {
                push(Kind::ConfigMap, cm, Relation::EnvFrom);
            }
            if let Some(sec) = ef.secret_ref.as_ref().map(|r| r.name.as_str()) {
                push(Kind::Secret, sec, Relation::EnvFrom);
            }
        }
        for env in c.env.as_deref().unwrap_or_default() {
            let Some(from) = env.value_from.as_ref() else { continue };
            if let Some(r) = from.config_map_key_ref.as_ref() {
                push(Kind::ConfigMap, &r.name, Relation::EnvFrom);
            }
            if let Some(r) = from.secret_key_ref.as_ref() {
                push(Kind::Secret, &r.name, Relation::EnvFrom);
            }
        }
    }
    let sa = spec.service_account_name.as_deref().unwrap_or("default");
    push(Kind::ServiceAccount, sa, Relation::UsesSa);
}

/// PersistentVolume -> PersistentVolumeClaim via pvc.spec.volumeName.
pub fn pv_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for pvc in store.iter_kind(Kind::PersistentVolumeClaim) {
        let Object::PersistentVolumeClaim(p) = pvc else { continue };
        let Some(vol) = p.spec.as_ref().and_then(|s| s.volume_name.as_deref()) else {
            continue;
        };
        if let Some(e) = edge_from_named(store, Kind::PersistentVolume, None, vol, pvc, Relation::Binds) {
            edges.push(e);
        }
    }
    edges
}

/// HorizontalPodAutoscaler -> scaleTargetRef (Deployment / StatefulSet / ReplicaSet).
pub fn hpa_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for hpa in store.iter_kind(Kind::HorizontalPodAutoscaler) {
        let Object::HorizontalPodAutoscaler(h) = hpa else { continue };
        let spec = &h.spec;
        let Some(kind) = Kind::parse(&spec.scale_target_ref.kind) else {
            continue;
        };
        if let Some(target) = store.find(kind, hpa.namespace(), &spec.scale_target_ref.name) {
            edges.push(Edge::new(id_of(hpa), id_of(target), Relation::Scales));
        }
    }
    edges
}

/// The directions a policy restricts. Unset `policyTypes` means Kubernetes' default: Ingress
/// always, Egress only when the policy has egress rules.
pub fn policy_types(spec: &NetworkPolicySpec) -> Vec<String> {
    match &spec.policy_types {
        Some(types) => types.clone(),
        None if spec.egress.as_ref().is_some_and(|e| !e.is_empty()) => vec!["Ingress".into(), "Egress".into()],
        None => vec!["Ingress".into()],
    }
}

/// NetworkPolicy -> each pod its `podSelector` picks (`applies`), and pod -> policy for each pod
/// an ingress `from` peer admits (`allows`) while ingress is in effect. ipBlock peers have no
/// graph edge.
pub fn network_policy_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    let all_pods = LabelSelector::default();
    for obj in store.iter_kind(Kind::NetworkPolicy) {
        let Object::NetworkPolicy(np) = obj else { continue };
        let Some(spec) = np.spec.as_ref() else { continue };
        let policy = id_of(obj);
        // A missing podSelector is the empty selector: every pod in the namespace.
        let selector = spec.pod_selector.as_ref().unwrap_or(&all_pods);
        for pod in store.iter_kind(Kind::Pod) {
            if pod.namespace() == obj.namespace() && label_selector_matches(selector, pod.meta().labels.as_ref()) {
                edges.push(Edge::new(policy.clone(), id_of(pod), Relation::Applies));
            }
        }
        // Ingress rules of a policy that does not restrict ingress admit nothing.
        let ingress = policy_types(spec).iter().any(|t| t == "Ingress");
        for peer in spec
            .ingress
            .iter()
            .flatten()
            .filter(|_| ingress)
            .flat_map(|r| r.from.iter().flatten())
        {
            if peer.pod_selector.is_none() && peer.namespace_selector.is_none() {
                continue;
            }
            for pod in store.iter_kind(Kind::Pod) {
                if peer_admits(peer, obj.namespace(), pod) {
                    edges.push(Edge::new(id_of(pod), policy.clone(), Relation::Allows));
                }
            }
        }
    }
    // A pod admitted by two peers of one policy is still one edge.
    edges.sort_by(|a, b| a.id.cmp(&b.id));
    edges.dedup_by(|a, b| a.id == b.id);
    edges
}

/// Namespaces are not watched, so a `namespaceSelector` is evaluated against the label every
/// namespace carries, `kubernetes.io/metadata.name`; selectors on other namespace labels match nothing.
fn peer_admits(peer: &NetworkPolicyPeer, policy_ns: Option<&str>, pod: &Object) -> bool {
    let in_namespace = match &peer.namespace_selector {
        None => pod.namespace() == policy_ns,
        Some(sel) => {
            let ns = BTreeMap::from([(
                "kubernetes.io/metadata.name".to_string(),
                pod.namespace().unwrap_or_default().to_string(),
            )]);
            label_selector_matches(sel, Some(&ns))
        }
    };
    in_namespace
        && peer
            .pod_selector
            .as_ref()
            .is_none_or(|sel| label_selector_matches(sel, pod.meta().labels.as_ref()))
}

/// RoleBinding/ClusterRoleBinding -> its roleRef (`grants`) and -> each ServiceAccount subject (`subject`).
pub fn rbac_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for binding in store.iter_kind(Kind::RoleBinding).chain(store.iter_kind(Kind::ClusterRoleBinding)) {
        let (role_ref, subjects) = match binding {
            Object::RoleBinding(b) => (&b.role_ref, b.subjects.as_deref().unwrap_or_default()),
            Object::ClusterRoleBinding(b) => (&b.role_ref, b.subjects.as_deref().unwrap_or_default()),
            _ => continue,
        };
        let role = match role_ref.kind.as_str() {
            "Role" => store.find(Kind::Role, binding.namespace(), &role_ref.name),
            "ClusterRole" => store.find(Kind::ClusterRole, None, &role_ref.name),
            _ => None,
        };
        if let Some(role) = role {
            edges.push(Edge::new(id_of(binding), id_of(role), Relation::Grants));
        }
        for s in subjects.iter().filter(|s| s.kind == "ServiceAccount") {
            // A RoleBinding's ServiceAccount subject without a namespace is in the binding's own.
            let ns = s.namespace.as_deref().or(binding.namespace());
            if let Some(sa) = store.find(Kind::ServiceAccount, ns, &s.name) {
                edges.push(Edge::new(id_of(binding), id_of(sa), Relation::Subject));
            }
        }
    }
    edges
}

/// Pod -> the Node in `spec.nodeName` (`runsOn`).
pub fn node_edges(store: &Store) -> Vec<Edge> {
    store
        .iter_kind(Kind::Pod)
        .filter_map(|pod| {
            let Object::Pod(p) = pod else { return None };
            let node = store.find(Kind::Node, None, p.spec.as_ref()?.node_name.as_deref()?)?;
            Some(Edge::new(id_of(pod), id_of(node), Relation::RunsOn))
        })
        .collect()
}

pub fn all_edges(store: &Store) -> Vec<Edge> {
    let mut edges = owner_edges(store);
    edges.extend(service_edges(store));
    edges.extend(ingress_edges(store));
    edges.extend(pod_input_edges(store));
    edges.extend(pv_edges(store));
    edges.extend(hpa_edges(store));
    edges.extend(network_policy_edges(store));
    edges.extend(rbac_edges(store));
    edges.extend(node_edges(store));
    edges
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::Relation;
    use crate::store::Store;

    fn ids(edges: &[Edge]) -> Vec<String> {
        let mut v: Vec<String> = edges.iter().map(|e| e.id.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn network_policies_apply_to_their_pods_and_admit_ingress_peers() {
        let s = Store::from_fixture("graph-extras").unwrap();
        assert_eq!(
            ids(&network_policy_edges(&s)),
            vec![
                "NetworkPolicy/s/deny-all->Pod/s/client-1:applies",
                "NetworkPolicy/s/deny-all->Pod/s/web-1:applies",
                "NetworkPolicy/s/web-ingress->Pod/s/web-1:applies",
                "Pod/s/client-1->NetworkPolicy/s/web-ingress:allows",
                "Pod/t/other-1->NetworkPolicy/s/web-ingress:allows",
            ]
        );
    }

    #[test]
    fn only_policies_with_ingress_in_effect_admit_peers() {
        let s = Store::from_yaml_docs(crate::graph::rows::tests::POLICY_TYPES).unwrap();
        let allows: Vec<String> = ids(&network_policy_edges(&s))
            .into_iter()
            .filter(|id| id.ends_with(":allows"))
            .collect();
        assert_eq!(allows, vec!["Pod/s/client-1->NetworkPolicy/s/implicit-egress:allows"]);
    }

    #[test]
    fn bindings_grant_roles_to_service_accounts() {
        let s = Store::from_fixture("graph-extras").unwrap();
        assert_eq!(
            ids(&rbac_edges(&s)),
            vec![
                "ClusterRoleBinding//system-only->ClusterRole//unused:grants",
                "ClusterRoleBinding//web-cluster->ClusterRole//view:grants",
                "ClusterRoleBinding//web-cluster->ServiceAccount/s/web:subject",
                "RoleBinding/s/web-reader->Role/s/reader:grants",
                "RoleBinding/s/web-reader->ServiceAccount/s/web:subject",
                "RoleBinding/s/web-view->ClusterRole//view:grants",
                "RoleBinding/s/web-view->ServiceAccount/s/web:subject",
            ]
        );
    }

    #[test]
    fn pods_run_on_their_nodes() {
        let s = Store::from_fixture("graph-extras").unwrap();
        assert_eq!(
            ids(&node_edges(&s)),
            vec![
                "Pod/s/client-1->Node//node-b:runsOn",
                "Pod/s/web-1->Node//node-a:runsOn",
                "Pod/t/other-1->Node//node-a:runsOn",
            ]
        );
    }

    #[test]
    fn owner_chain_edges() {
        let s = Store::from_fixture("relations").unwrap();
        assert_eq!(
            ids(&owner_edges(&s)),
            vec![
                "CronJob/r/nightly->Job/r/nightly-1:owns",
                "Deployment/r/web->ReplicaSet/r/web-1:owns",
                "Job/r/nightly-1->Pod/r/nightly-1-x:owns",
                "ReplicaSet/r/web-1->Pod/r/web-1-a:owns",
            ]
        );
    }

    #[test]
    fn service_selector_edges_skip_headless_and_unmatched() {
        let s = Store::from_fixture("relations").unwrap();
        // Also proves the cross-namespace guard: `web-other` (namespace `other`) has
        // matching labels but must not be selected by `web-svc` (namespace `r`).
        assert_eq!(ids(&service_edges(&s)), vec!["Service/r/web-svc->Pod/r/web-1-a:selects"]);
    }

    #[test]
    fn ingress_edges_include_default_backend_and_skip_missing_services() {
        let s = Store::from_fixture("relations").unwrap();
        assert_eq!(
            ids(&ingress_edges(&s)),
            vec![
                "Ingress/r/web-ing->Service/r/fallback:routes",
                "Ingress/r/web-ing->Service/r/web-svc:routes"
            ]
        );
    }

    #[test]
    fn pod_input_edges_cover_volumes_env_pvc_and_sa() {
        let s = Store::from_fixture("relations").unwrap();
        let edges = pod_input_edges(&s);
        assert_eq!(
            ids(&edges),
            vec![
                "ConfigMap/r/env-cm->Pod/r/web-1-a:envFrom",
                "ConfigMap/r/flags-cm->Pod/r/web-1-a:envFrom",
                "ConfigMap/r/init-cm->Pod/r/web-1-a:envFrom",
                "ConfigMap/r/mounted-cm->Pod/r/web-1-a:mounts",
                "ConfigMap/r/proj-cm->Pod/r/web-1-a:mounts",
                "PersistentVolumeClaim/r/data-pvc->Pod/r/web-1-a:claims",
                "Secret/r/db-secret->Pod/r/web-1-a:envFrom",
                "Secret/r/env-secret->Pod/r/web-1-a:envFrom",
                "Secret/r/mounted-secret->Pod/r/web-1-a:mounts",
                "Secret/r/proj-secret->Pod/r/web-1-a:mounts",
                "ServiceAccount/r/default->Pod/r/default-sa-pod:usesSA",
                "ServiceAccount/r/default->Pod/r/nightly-1-x:usesSA",
                "ServiceAccount/r/web-sa->Pod/r/web-1-a:usesSA",
            ]
        );
        assert!(edges.iter().all(|e| e.relation != Relation::Owns));
    }

    #[test]
    fn pv_and_hpa_edges() {
        let s = Store::from_fixture("relations").unwrap();
        assert_eq!(
            ids(&pv_edges(&s)),
            vec!["PersistentVolume//pv-data->PersistentVolumeClaim/r/data-pvc:binds"]
        );
        assert_eq!(
            ids(&hpa_edges(&s)),
            vec!["HorizontalPodAutoscaler/r/web-hpa->Deployment/r/web:scales"]
        );
    }

    #[test]
    fn all_edges_is_the_union() {
        let s = Store::from_fixture("relations").unwrap();
        let all = all_edges(&s);
        let expected = owner_edges(&s).len()
            + service_edges(&s).len()
            + ingress_edges(&s).len()
            + pod_input_edges(&s).len()
            + pv_edges(&s).len()
            + hpa_edges(&s).len()
            + network_policy_edges(&s).len()
            + rbac_edges(&s).len()
            + node_edges(&s).len();
        assert_eq!(all.len(), expected);
    }
}
