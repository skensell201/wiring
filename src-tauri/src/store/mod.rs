//! In-memory cache of Kubernetes objects for the selected namespace.
//! Pure data — no async, no client.

pub mod yaml;

use std::collections::HashMap;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service, ServiceAccount};
use k8s_openapi::api::networking::v1::Ingress;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Kind {
    Deployment,
    StatefulSet,
    DaemonSet,
    ReplicaSet,
    Job,
    CronJob,
    Pod,
    Service,
    Ingress,
    ConfigMap,
    Secret,
    PersistentVolumeClaim,
    PersistentVolume,
    ServiceAccount,
    HorizontalPodAutoscaler,
    /// Synthetic node kind: a collapsed group of pods. Never stored.
    PodGroup,
}

impl Kind {
    pub const WATCHED: [Kind; 15] = [
        Kind::Deployment,
        Kind::StatefulSet,
        Kind::DaemonSet,
        Kind::ReplicaSet,
        Kind::Job,
        Kind::CronJob,
        Kind::Pod,
        Kind::Service,
        Kind::Ingress,
        Kind::ConfigMap,
        Kind::Secret,
        Kind::PersistentVolumeClaim,
        Kind::PersistentVolume,
        Kind::ServiceAccount,
        Kind::HorizontalPodAutoscaler,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Deployment => "Deployment",
            Kind::StatefulSet => "StatefulSet",
            Kind::DaemonSet => "DaemonSet",
            Kind::ReplicaSet => "ReplicaSet",
            Kind::Job => "Job",
            Kind::CronJob => "CronJob",
            Kind::Pod => "Pod",
            Kind::Service => "Service",
            Kind::Ingress => "Ingress",
            Kind::ConfigMap => "ConfigMap",
            Kind::Secret => "Secret",
            Kind::PersistentVolumeClaim => "PersistentVolumeClaim",
            Kind::PersistentVolume => "PersistentVolume",
            Kind::ServiceAccount => "ServiceAccount",
            Kind::HorizontalPodAutoscaler => "HorizontalPodAutoscaler",
            Kind::PodGroup => "PodGroup",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        Kind::WATCHED.iter().copied().find(|k| k.as_str() == s)
    }

    pub fn is_cluster_scoped(self) -> bool {
        matches!(self, Kind::PersistentVolume)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ObjectKey {
    pub kind: Kind,
    pub namespace: Option<String>,
    pub name: String,
}

impl ObjectKey {
    /// Normalizes `namespace` to `None` for cluster-scoped kinds, regardless of what was passed in.
    pub fn new(kind: Kind, namespace: Option<&str>, name: &str) -> ObjectKey {
        let namespace = if kind.is_cluster_scoped() {
            None
        } else {
            namespace.map(str::to_owned)
        };
        ObjectKey {
            kind,
            namespace,
            name: name.to_owned(),
        }
    }
}

// Object count is bounded (one namespace); simplicity beats boxing here.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum Object {
    Deployment(Deployment),
    StatefulSet(StatefulSet),
    DaemonSet(DaemonSet),
    ReplicaSet(ReplicaSet),
    Job(Job),
    CronJob(CronJob),
    Pod(Pod),
    Service(Service),
    Ingress(Ingress),
    ConfigMap(ConfigMap),
    Secret(Secret),
    PersistentVolumeClaim(PersistentVolumeClaim),
    PersistentVolume(PersistentVolume),
    ServiceAccount(ServiceAccount),
    HorizontalPodAutoscaler(HorizontalPodAutoscaler),
}

macro_rules! for_each_object {
    ($self:expr, $o:ident => $body:expr) => {
        match $self {
            Object::Deployment($o) => $body,
            Object::StatefulSet($o) => $body,
            Object::DaemonSet($o) => $body,
            Object::ReplicaSet($o) => $body,
            Object::Job($o) => $body,
            Object::CronJob($o) => $body,
            Object::Pod($o) => $body,
            Object::Service($o) => $body,
            Object::Ingress($o) => $body,
            Object::ConfigMap($o) => $body,
            Object::Secret($o) => $body,
            Object::PersistentVolumeClaim($o) => $body,
            Object::PersistentVolume($o) => $body,
            Object::ServiceAccount($o) => $body,
            Object::HorizontalPodAutoscaler($o) => $body,
        }
    };
}

impl Object {
    pub fn kind(&self) -> Kind {
        match self {
            Object::Deployment(_) => Kind::Deployment,
            Object::StatefulSet(_) => Kind::StatefulSet,
            Object::DaemonSet(_) => Kind::DaemonSet,
            Object::ReplicaSet(_) => Kind::ReplicaSet,
            Object::Job(_) => Kind::Job,
            Object::CronJob(_) => Kind::CronJob,
            Object::Pod(_) => Kind::Pod,
            Object::Service(_) => Kind::Service,
            Object::Ingress(_) => Kind::Ingress,
            Object::ConfigMap(_) => Kind::ConfigMap,
            Object::Secret(_) => Kind::Secret,
            Object::PersistentVolumeClaim(_) => Kind::PersistentVolumeClaim,
            Object::PersistentVolume(_) => Kind::PersistentVolume,
            Object::ServiceAccount(_) => Kind::ServiceAccount,
            Object::HorizontalPodAutoscaler(_) => Kind::HorizontalPodAutoscaler,
        }
    }

    pub fn meta(&self) -> &ObjectMeta {
        for_each_object!(self, o => &o.metadata)
    }

    pub fn meta_mut(&mut self) -> &mut ObjectMeta {
        for_each_object!(self, o => &mut o.metadata)
    }

    pub fn name(&self) -> &str {
        self.meta().name.as_deref().unwrap_or_default()
    }

    pub fn namespace(&self) -> Option<&str> {
        self.meta().namespace.as_deref()
    }

    pub fn uid(&self) -> Option<&str> {
        self.meta().uid.as_deref()
    }

    pub fn key(&self) -> ObjectKey {
        ObjectKey::new(self.kind(), self.namespace(), self.name())
    }

    /// Serialize to JSON with server-side noise (managedFields) removed.
    pub fn to_json_value(&self) -> serde_json::Value {
        let mut clone = self.clone();
        clone.meta_mut().managed_fields = None;
        for_each_object!(&clone, o => serde_json::to_value(o).unwrap_or(serde_json::Value::Null))
    }
}

#[derive(Debug, Default, Clone)]
pub struct Store {
    objects: HashMap<ObjectKey, Object>,
    /// The latest metrics-server sample of this namespace (written by `session::metrics`).
    pub metrics: crate::metrics::MetricsSample,
}

impl Store {
    pub fn upsert(&mut self, obj: Object) {
        self.objects.insert(obj.key(), obj);
    }

    pub fn remove(&mut self, key: &ObjectKey) -> Option<Object> {
        self.objects.remove(key)
    }

    pub fn get(&self, key: &ObjectKey) -> Option<&Object> {
        self.objects.get(key)
    }

    pub fn len(&self) -> usize {
        self.objects.len()
    }

    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Object> {
        self.objects.values()
    }

    pub fn iter_kind(&self, kind: Kind) -> impl Iterator<Item = &Object> {
        self.objects.values().filter(move |o| o.kind() == kind)
    }

    /// Look up by kind + namespace + name; `namespace` is ignored for cluster-scoped kinds.
    pub fn find(&self, kind: Kind, namespace: Option<&str>, name: &str) -> Option<&Object> {
        self.objects.get(&ObjectKey::new(kind, namespace, name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::Pod;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ManagedFieldsEntry, ObjectMeta};

    fn pod(ns: &str, name: &str) -> Object {
        Object::Pod(Pod {
            metadata: ObjectMeta {
                name: Some(name.into()),
                namespace: Some(ns.into()),
                ..Default::default()
            },
            ..Default::default()
        })
    }

    #[test]
    fn kind_round_trips_through_str() {
        for k in Kind::WATCHED {
            assert_eq!(Kind::parse(k.as_str()), Some(k));
        }
        assert_eq!(Kind::parse("Nope"), None);
    }

    #[test]
    fn object_key_uses_kind_namespace_name() {
        let key = pod("payments", "web-1").key();
        assert_eq!(
            key,
            ObjectKey {
                kind: Kind::Pod,
                namespace: Some("payments".into()),
                name: "web-1".into()
            }
        );
    }

    #[test]
    fn store_upsert_get_remove() {
        let mut store = Store::default();
        store.upsert(pod("payments", "web-1"));
        store.upsert(pod("payments", "web-1")); // idempotent
        store.upsert(pod("payments", "web-2"));
        assert_eq!(store.len(), 2);
        let key = pod("payments", "web-1").key();
        assert!(store.get(&key).is_some());
        store.remove(&key);
        assert!(store.get(&key).is_none());
        assert_eq!(store.iter_kind(Kind::Pod).count(), 1);
    }

    #[test]
    fn cluster_scoped_keys_ignore_namespace() {
        let pv = Object::PersistentVolume(PersistentVolume {
            metadata: ObjectMeta {
                name: Some("pv-1".into()),
                namespace: None,
                ..Default::default()
            },
            ..Default::default()
        });
        let mut store = Store::default();
        store.upsert(pv);
        assert!(store.find(Kind::PersistentVolume, Some("some-ns"), "pv-1").is_some());

        let pv_with_ns = Object::PersistentVolume(PersistentVolume {
            metadata: ObjectMeta {
                name: Some("pv-2".into()),
                namespace: Some("x".into()),
                ..Default::default()
            },
            ..Default::default()
        });
        assert_eq!(pv_with_ns.key().namespace, None);
    }

    #[test]
    fn to_json_value_strips_managed_fields() {
        let plain = pod("payments", "web-1");
        let mut with_managed_fields = pod("payments", "web-1");
        with_managed_fields.meta_mut().managed_fields = Some(vec![ManagedFieldsEntry {
            manager: Some("kubectl".into()),
            ..Default::default()
        }]);

        let plain_json = plain.to_json_value();
        let with_managed_fields_json = with_managed_fields.to_json_value();
        assert_eq!(plain_json, with_managed_fields_json);
        assert!(with_managed_fields_json["metadata"].get("managedFields").is_none());
    }
}
