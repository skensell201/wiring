//! Write path of a `Session`: update / create / delete through the live client.
//!
//! Every write goes through `Api<DynamicObject>` for the kind's `ApiResource`, so the same
//! code serves all watched kinds. Manifests are never logged (Secrets).

use futures::future::join_all;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service, ServiceAccount};
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::{Api, DeleteParams, PostParams};
use kube::core::{ApiResource, DynamicObject, Request, Resource};
use serde_json::Value;

use super::{parse_node_id, ObjectDetails, Session};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::build::group_members;
use crate::graph::{node_id, NodeId};
use crate::manifest::{self, Manifest};
use crate::store::{Kind, Object};

/// Type-erased API description of a watched kind; `None` for the synthetic PodGroup.
fn api_resource(kind: Kind) -> Option<ApiResource> {
    macro_rules! erase {
        ($t:ty) => {
            Some(ApiResource::erase::<$t>(&()))
        };
    }
    match kind {
        Kind::Deployment => erase!(Deployment),
        Kind::StatefulSet => erase!(StatefulSet),
        Kind::DaemonSet => erase!(DaemonSet),
        Kind::ReplicaSet => erase!(ReplicaSet),
        Kind::Job => erase!(Job),
        Kind::CronJob => erase!(CronJob),
        Kind::Pod => erase!(Pod),
        Kind::Service => erase!(Service),
        Kind::Ingress => erase!(Ingress),
        Kind::ConfigMap => erase!(ConfigMap),
        Kind::Secret => erase!(Secret),
        Kind::PersistentVolumeClaim => erase!(PersistentVolumeClaim),
        Kind::PersistentVolume => erase!(PersistentVolume),
        Kind::ServiceAccount => erase!(ServiceAccount),
        Kind::HorizontalPodAutoscaler => erase!(HorizontalPodAutoscaler),
        Kind::PodGroup => None,
    }
}

fn resource_for(kind: Kind) -> AppResult<ApiResource> {
    api_resource(kind).ok_or_else(|| AppError::new(ErrorKind::Invalid, format!("{} is not an API resource", kind.as_str())))
}

/// Ask the server to reject unknown or duplicate fields instead of silently dropping them.
/// kube 4.2's `PostParams` cannot express `fieldValidation`, so it is appended to the query.
fn with_strict_validation(mut req: http::Request<Vec<u8>>) -> AppResult<http::Request<Vec<u8>>> {
    let path = req.uri().path();
    let uri = match req.uri().query().filter(|q| !q.is_empty()) {
        Some(query) => format!("{path}?{query}&fieldValidation=Strict"),
        None => format!("{path}?fieldValidation=Strict"),
    };
    *req.uri_mut() = uri
        .parse()
        .map_err(|e: http::uri::InvalidUri| AppError::internal(format!("request uri: {e}")))?;
    Ok(req)
}

/// The identity fields a manifest may omit and that the request path already fixes.
fn fill_type_and_namespace(body: &mut Value, ar: &ApiResource, namespace: Option<&str>) {
    if let Some(obj) = body.as_object_mut() {
        obj.entry("apiVersion").or_insert_with(|| Value::String(ar.api_version.clone()));
    }
    if let (Some(ns), Some(meta)) = (namespace, body.get_mut("metadata").and_then(Value::as_object_mut)) {
        meta.insert("namespace".into(), Value::String(ns.to_owned()));
    }
}

fn set_resource_version(body: &mut Value, resource_version: &str) {
    if let Some(meta) = body.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.insert("resourceVersion".into(), Value::String(resource_version.to_owned()));
    }
}

/// The namespace a manifest's object lives in: none for cluster-scoped kinds, else the
/// manifest's own `metadata.namespace` or the caller's fallback.
fn target_namespace(m: &Manifest, fallback: Option<&str>) -> AppResult<Option<String>> {
    if m.kind.is_cluster_scoped() {
        return Ok(None);
    }
    m.namespace
        .clone()
        .or_else(|| fallback.filter(|ns| !ns.is_empty()).map(str::to_owned))
        .map(Some)
        .ok_or_else(|| AppError::new(ErrorKind::Invalid, "metadata.namespace is missing and no namespace is selected"))
}

fn kube_err(e: kube::Error) -> AppError {
    AppError::from(&e)
}

/// A delete that already happened counts as done.
async fn delete_one(api: &Api<DynamicObject>, name: &str) -> AppResult<()> {
    match api.delete(name, &DeleteParams::default()).await {
        Ok(_) => Ok(()),
        Err(e) => match AppError::from(&e) {
            err if err.kind == ErrorKind::NotFound => Ok(()),
            err => Err(err),
        },
    }
}

impl Session {
    fn dynamic_api(&self, ar: &ApiResource, namespace: Option<&str>) -> Api<DynamicObject> {
        match namespace {
            Some(ns) => Api::namespaced_with(self.client.clone(), ns, ar),
            None => Api::all_with(self.client.clone(), ar),
        }
    }

    /// Replace the object `node_id` names with `yaml`. Without `force` the server enforces
    /// the manifest's `resourceVersion` (a stale one is a `conflict`); with `force` the
    /// current version is copied in first. The saved object is stored right away so the
    /// returned details are fresh before the watch echoes the change.
    pub async fn update_object(&self, node_id: &str, yaml: &str, force: bool) -> AppResult<ObjectDetails> {
        let m = manifest::parse(yaml)?;
        manifest::ensure_matches(&m, node_id)?;
        let ar = resource_for(m.kind)?;
        let namespace = target_namespace(&m, None)?;
        let mut body = m.body;
        fill_type_and_namespace(&mut body, &ar, namespace.as_deref());
        if force {
            let current = self.dynamic_api(&ar, namespace.as_deref()).get(&m.name).await.map_err(kube_err)?;
            let rv = current
                .metadata
                .resource_version
                .ok_or_else(|| AppError::internal(format!("{node_id} has no resourceVersion")))?;
            set_resource_version(&mut body, &rv);
        }
        let bytes = serde_json::to_vec(&body).map_err(|e| AppError::internal(e.to_string()))?;
        let req = Request::new(DynamicObject::url_path(&ar, namespace.as_deref()))
            .replace(&m.name, &PostParams::default(), bytes)
            .map_err(|e| AppError::internal(e.to_string()))?;
        let saved: Value = self.client.request(with_strict_validation(req)?).await.map_err(kube_err)?;
        let obj = Object::from_json_value(saved).map_err(AppError::internal)?;
        self.shared.store().upsert(obj);
        self.get_object(node_id)
    }

    /// Create the object in `yaml`; its own `metadata.namespace` wins over `namespace`
    /// (ignored for cluster-scoped kinds). Returns the new object's node id; the object
    /// itself reaches the graph through the watch.
    pub async fn create_object(&self, namespace: &str, yaml: &str) -> AppResult<NodeId> {
        let m = manifest::parse(yaml)?;
        let ar = resource_for(m.kind)?;
        let namespace = target_namespace(&m, Some(namespace))?;
        let mut body = m.body;
        fill_type_and_namespace(&mut body, &ar, namespace.as_deref());
        let bytes = serde_json::to_vec(&body).map_err(|e| AppError::internal(e.to_string()))?;
        let req = Request::new(DynamicObject::url_path(&ar, namespace.as_deref()))
            .create(&PostParams::default(), bytes)
            .map_err(|e| AppError::internal(e.to_string()))?;
        let _created: Value = self.client.request(with_strict_validation(req)?).await.map_err(kube_err)?;
        Ok(node_id(m.kind, namespace.as_deref(), &m.name))
    }

    /// Delete the object `node_id` names, or every member pod of a PodGroup. Objects that are
    /// already gone count as deleted; a partial PodGroup failure names the pods left behind.
    pub async fn delete_object(&self, node_id: &str) -> AppResult<()> {
        let (kind, ns, name) = parse_node_id(node_id)?;
        if kind != Kind::PodGroup {
            let ar = resource_for(kind)?;
            return delete_one(&self.dynamic_api(&ar, ns.as_deref()), &name).await;
        }
        // Lock scope: the std mutex must not be held across the awaits below.
        let members = group_members(&self.shared.store(), node_id);
        if members.is_empty() {
            return Err(AppError::new(ErrorKind::NotFound, format!("{node_id} has no member pods")));
        }
        let api = self.dynamic_api(&resource_for(Kind::Pod)?, ns.as_deref());
        let results = join_all(members.iter().map(|key| delete_one(&api, &key.name))).await;
        let mut failed = Vec::new();
        let mut first_error: Option<AppError> = None;
        for (key, result) in members.iter().zip(results) {
            if let Err(e) = result {
                failed.push(key.name.clone());
                first_error.get_or_insert(e);
            }
        }
        match first_error {
            None => Ok(()),
            Some(err) => Err(AppError::new(
                err.kind,
                format!("failed to delete: {} ({})", failed.join(", "), err.message),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_watched_kind_has_an_api_resource() {
        for kind in Kind::WATCHED {
            let ar = api_resource(kind).unwrap_or_else(|| panic!("{kind:?}"));
            assert_eq!(ar.kind, kind.as_str());
        }
        assert!(api_resource(Kind::PodGroup).is_none());
        let dep = api_resource(Kind::Deployment).unwrap();
        assert_eq!(dep.api_version, "apps/v1");
        assert_eq!(dep.plural, "deployments");
        assert_eq!(
            DynamicObject::url_path(&dep, Some("shop")),
            "/apis/apps/v1/namespaces/shop/deployments"
        );
        let pv = api_resource(Kind::PersistentVolume).unwrap();
        assert_eq!(DynamicObject::url_path(&pv, None), "/api/v1/persistentvolumes");
    }

    #[test]
    fn strict_validation_is_appended_to_the_query() {
        let cm = api_resource(Kind::ConfigMap).unwrap();
        let base = Request::new(DynamicObject::url_path(&cm, Some("shop")));

        let req = with_strict_validation(base.replace("web", &PostParams::default(), vec![]).unwrap()).unwrap();
        assert_eq!(req.method(), http::Method::PUT);
        assert_eq!(
            req.uri().to_string(),
            "/api/v1/namespaces/shop/configmaps/web?fieldValidation=Strict"
        );

        let pp = PostParams {
            field_manager: Some("wiring".into()),
            ..Default::default()
        };
        let req = with_strict_validation(base.create(&pp, vec![]).unwrap()).unwrap();
        assert_eq!(req.method(), http::Method::POST);
        // The leading `&` is kube's own query serialisation; the server ignores it.
        assert_eq!(
            req.uri().to_string(),
            "/api/v1/namespaces/shop/configmaps?&fieldManager=wiring&fieldValidation=Strict"
        );
    }

    #[test]
    fn fills_api_version_and_namespace_without_overwriting_api_version() {
        let cm = api_resource(Kind::ConfigMap).unwrap();
        let mut body = serde_json::json!({ "kind": "ConfigMap", "metadata": { "name": "x" } });
        fill_type_and_namespace(&mut body, &cm, Some("shop"));
        assert_eq!(body["apiVersion"], "v1");
        assert_eq!(body["metadata"]["namespace"], "shop");

        let mut body = serde_json::json!({ "apiVersion": "v2", "kind": "ConfigMap", "metadata": { "name": "x" } });
        fill_type_and_namespace(&mut body, &cm, None);
        assert_eq!(body["apiVersion"], "v2", "a user-supplied apiVersion is sent as-is");
        assert!(body["metadata"].get("namespace").is_none());

        set_resource_version(&mut body, "42");
        assert_eq!(body["metadata"]["resourceVersion"], "42");
    }

    #[test]
    fn target_namespace_prefers_the_manifest_then_the_fallback() {
        let m = manifest::parse("kind: ConfigMap\nmetadata:\n  name: x\n  namespace: own\n").unwrap();
        assert_eq!(target_namespace(&m, Some("selected")).unwrap().as_deref(), Some("own"));
        let m = manifest::parse("kind: ConfigMap\nmetadata:\n  name: x\n").unwrap();
        assert_eq!(target_namespace(&m, Some("selected")).unwrap().as_deref(), Some("selected"));
        let err = target_namespace(&m, Some("")).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(target_namespace(&m, None).unwrap_err().kind, ErrorKind::Invalid);
        let pv = manifest::parse("kind: PersistentVolume\nmetadata:\n  name: pv\n  namespace: ignored\n").unwrap();
        assert_eq!(target_namespace(&pv, Some("selected")).unwrap(), None);
    }
}
