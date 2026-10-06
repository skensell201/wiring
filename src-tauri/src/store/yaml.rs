//! Build a `Store` from multi-document YAML. Used by tests and fixtures.

use super::{Kind, Object, Store};
use serde::Deserialize;

impl Object {
    /// Deserialize one document whose `kind` field selects the variant.
    pub fn from_json_value(value: serde_json::Value) -> Result<Object, String> {
        let kind_str = value
            .get("kind")
            .and_then(|k| k.as_str())
            .ok_or_else(|| "document has no `kind`".to_string())?;
        let kind = Kind::parse(kind_str).ok_or_else(|| format!("unsupported kind `{kind_str}`"))?;
        macro_rules! de {
            ($variant:ident) => {
                serde_json::from_value(value.clone())
                    .map(Object::$variant)
                    .map_err(|e| format!("{kind_str}: {e}"))
            };
        }
        match kind {
            Kind::Deployment => de!(Deployment),
            Kind::StatefulSet => de!(StatefulSet),
            Kind::DaemonSet => de!(DaemonSet),
            Kind::ReplicaSet => de!(ReplicaSet),
            Kind::Job => de!(Job),
            Kind::CronJob => de!(CronJob),
            Kind::Pod => de!(Pod),
            Kind::Service => de!(Service),
            Kind::Ingress => de!(Ingress),
            Kind::ConfigMap => de!(ConfigMap),
            Kind::Secret => de!(Secret),
            Kind::PersistentVolumeClaim => de!(PersistentVolumeClaim),
            Kind::PersistentVolume => de!(PersistentVolume),
            Kind::ServiceAccount => de!(ServiceAccount),
            Kind::HorizontalPodAutoscaler => de!(HorizontalPodAutoscaler),
            Kind::NetworkPolicy => de!(NetworkPolicy),
            Kind::Role => de!(Role),
            Kind::RoleBinding => de!(RoleBinding),
            Kind::ClusterRole => de!(ClusterRole),
            Kind::ClusterRoleBinding => de!(ClusterRoleBinding),
            Kind::Node => de!(Node),
            Kind::PodGroup => Err("PodGroup is synthetic and cannot be loaded".into()),
            Kind::Custom => Err("custom resources are not stored".into()),
        }
    }
}

impl Store {
    pub fn from_yaml_docs(yaml: &str) -> Result<Store, String> {
        let mut store = Store::default();
        for doc in serde_yaml_ng::Deserializer::from_str(yaml) {
            let value = serde_json::Value::deserialize(doc).map_err(|e| e.to_string())?;
            if value.is_null() {
                continue;
            }
            store.upsert(Object::from_json_value(value)?);
        }
        Ok(store)
    }

    /// Load `tests/fixtures/<name>.yaml` relative to the crate root. Test-only: every call
    /// site is an inline `#[cfg(test)]` unit test, and the `tests/` integration binaries
    /// build their own fixtures inline (they cannot see `#[cfg(test)]` items anyway).
    #[cfg(test)]
    pub fn from_fixture(name: &str) -> Result<Store, String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(format!("{name}.yaml"));
        let yaml = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Store::from_yaml_docs(&yaml)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Kind;

    #[test]
    fn loads_every_document_by_kind() {
        let store = Store::from_fixture("deployment-basic").unwrap();
        assert_eq!(store.len(), 4);
        assert_eq!(store.iter_kind(Kind::Deployment).count(), 1);
        assert_eq!(store.iter_kind(Kind::ReplicaSet).count(), 1);
        assert_eq!(store.iter_kind(Kind::Pod).count(), 2);
        let dep = store.find(Kind::Deployment, Some("payments"), "web").unwrap();
        assert_eq!(dep.uid(), Some("dep-web"));
    }

    #[test]
    fn unknown_kind_is_an_error() {
        let err = Store::from_yaml_docs("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: n1\n").unwrap_err();
        assert!(err.contains("Namespace"), "{err}");
    }
}
