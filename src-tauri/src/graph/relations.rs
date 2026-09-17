//! Derive edges between objects in a Store. Every function only emits an edge
//! when both endpoints exist in the store.

use k8s_openapi::api::core::v1::PodSpec;

use super::model::{node_id, Edge, Relation};
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
        let Some(refs) = child.meta().owner_references.as_ref() else { continue };
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
        let Some(selector) = s.spec.as_ref().and_then(|s| s.selector.as_ref()) else { continue };
        for pod in store.iter_kind(Kind::Pod).filter(|p| p.namespace() == svc.namespace()) {
            if selector_matches(selector, pod.meta().labels.as_ref()) {
                edges.push(Edge::new(id_of(svc), id_of(pod), Relation::Selects));
            }
        }
    }
    edges
}

/// Ingress -> Service via rules[].http.paths[].backend.service and defaultBackend.
pub fn ingress_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for ing in store.iter_kind(Kind::Ingress) {
        let Object::Ingress(i) = ing else { continue };
        let Some(spec) = i.spec.as_ref() else { continue };
        let mut names: Vec<String> = vec![];
        if let Some(name) = spec.default_backend.as_ref().and_then(|b| b.service.as_ref()).map(|s| s.name.clone()) {
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
        for name in names {
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
        let Some(vol) = p.spec.as_ref().and_then(|s| s.volume_name.as_deref()) else { continue };
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
        let Some(kind) = Kind::parse(&spec.scale_target_ref.kind) else { continue };
        if let Some(target) = store.find(kind, hpa.namespace(), &spec.scale_target_ref.name) {
            edges.push(Edge::new(id_of(hpa), id_of(target), Relation::Scales));
        }
    }
    edges
}

pub fn all_edges(store: &Store) -> Vec<Edge> {
    let mut edges = owner_edges(store);
    edges.extend(service_edges(store));
    edges.extend(ingress_edges(store));
    edges.extend(pod_input_edges(store));
    edges.extend(pv_edges(store));
    edges.extend(hpa_edges(store));
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
        assert_eq!(ids(&service_edges(&s)), vec!["Service/r/web-svc->Pod/r/web-1-a:selects"]);
    }

    #[test]
    fn ingress_edges_include_default_backend_and_skip_missing_services() {
        let s = Store::from_fixture("relations").unwrap();
        assert_eq!(
            ids(&ingress_edges(&s)),
            vec!["Ingress/r/web-ing->Service/r/fallback:routes", "Ingress/r/web-ing->Service/r/web-svc:routes"]
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
        assert_eq!(ids(&pv_edges(&s)), vec!["PersistentVolume//pv-data->PersistentVolumeClaim/r/data-pvc:binds"]);
        assert_eq!(ids(&hpa_edges(&s)), vec!["HorizontalPodAutoscaler/r/web-hpa->Deployment/r/web:scales"]);
    }

    #[test]
    fn all_edges_is_the_union() {
        let s = Store::from_fixture("relations").unwrap();
        let all = all_edges(&s);
        let expected = owner_edges(&s).len() + service_edges(&s).len() + ingress_edges(&s).len()
            + pod_input_edges(&s).len() + pv_edges(&s).len() + hpa_edges(&s).len();
        assert_eq!(all.len(), expected);
    }
}
