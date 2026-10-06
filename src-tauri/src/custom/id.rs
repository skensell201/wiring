//! `Custom/<group>/<version>/<kind>/<namespace>/<name>`: the node id of a custom resource.
//! The namespace is empty for cluster-scoped kinds, the group for the core group.

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::NodeId;

pub const PREFIX: &str = "Custom/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomId {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

fn malformed(id: &str) -> AppError {
    AppError::new(ErrorKind::NotFound, format!("malformed node id `{id}`"))
}

fn is_alnum(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit()
}

/// DNS-1123 label: lowercase alphanumerics and `-`, alphanumeric at both ends, at most 63 bytes.
fn is_label(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 63 && is_alnum(b[0]) && is_alnum(b[b.len() - 1]) && b.iter().all(|&c| is_alnum(c) || c == b'-')
}

/// DNS-1123 subdomain: dot-separated labels, at most 253 bytes.
fn is_subdomain(s: &str) -> bool {
    s.len() <= 253 && s.split('.').all(is_label)
}

/// A CRD kind: a letter, then letters and digits (at most 63 bytes).
fn is_kind(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 63 && b[0].is_ascii_alphabetic() && b.iter().all(u8::is_ascii_alphanumeric)
}

impl CustomId {
    pub fn parse(id: &str) -> AppResult<CustomId> {
        let rest = id.strip_prefix(PREFIX).ok_or_else(|| malformed(id))?;
        let parts: Vec<&str> = rest.split('/').collect();
        let [group, version, kind, namespace, name] = parts[..] else {
            return Err(malformed(id));
        };
        // Every segment ends up in an API URL path, so each must be a valid Kubernetes name:
        // no `/`, `?`, `%`, `..` or other characters that could add or alter a path segment.
        let valid = (group.is_empty() || is_subdomain(group))
            && is_label(version)
            && is_kind(kind)
            && (namespace.is_empty() || is_label(namespace))
            && is_subdomain(name);
        if !valid {
            return Err(malformed(id));
        }
        Ok(CustomId {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
            namespace: (!namespace.is_empty()).then(|| namespace.to_string()),
            name: name.into(),
        })
    }

    /// `Some` for a custom id, `None` for any other node id; a malformed custom id is an error.
    pub fn of(id: &str) -> AppResult<Option<CustomId>> {
        if id.starts_with(PREFIX) {
            CustomId::parse(id).map(Some)
        } else {
            Ok(None)
        }
    }

    pub fn node_id(&self) -> NodeId {
        custom_node_id(&self.group, &self.version, &self.kind, self.namespace.as_deref(), &self.name)
    }

    pub fn api_version(&self) -> String {
        if self.group.is_empty() {
            self.version.clone()
        } else {
            format!("{}/{}", self.group, self.version)
        }
    }
}

pub fn custom_node_id(group: &str, version: &str, kind: &str, namespace: Option<&str>, name: &str) -> NodeId {
    format!("{PREFIX}{group}/{version}/{kind}/{}/{name}", namespace.unwrap_or(""))
}

/// `cert-manager.io/v1` → (`cert-manager.io`, `v1`); `v1` → (``, `v1`).
pub fn split_api_version(api_version: &str) -> (&str, &str) {
    api_version.split_once('/').unwrap_or(("", api_version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_namespaced_id_round_trips() {
        let id = "Custom/cert-manager.io/v1/Certificate/shop/web-tls";
        let c = CustomId::parse(id).unwrap();
        assert_eq!(
            c,
            CustomId {
                group: "cert-manager.io".into(),
                version: "v1".into(),
                kind: "Certificate".into(),
                namespace: Some("shop".into()),
                name: "web-tls".into(),
            }
        );
        assert_eq!(c.node_id(), id);
        assert_eq!(c.api_version(), "cert-manager.io/v1");
    }

    #[test]
    fn cluster_scoped_and_core_group_ids() {
        let c = CustomId::parse("Custom/cert-manager.io/v1/ClusterIssuer//letsencrypt").unwrap();
        assert_eq!(c.namespace, None);
        assert_eq!(c.node_id(), "Custom/cert-manager.io/v1/ClusterIssuer//letsencrypt");
        let core = CustomId::parse("Custom//v1/Widget/ns/w").unwrap();
        assert_eq!(core.group, "");
        assert_eq!(core.api_version(), "v1");
    }

    #[test]
    fn malformed_ids_are_rejected() {
        for bad in [
            "Custom/cert-manager.io/v1/Certificate/web-tls",
            "Custom/cert-manager.io//Certificate/ns/x",
            "Custom/cert-manager.io/v1//ns/x",
            "Custom/cert-manager.io/v1/Certificate/ns/",
            "Custom/cert-manager.io/v1/Certificate/ns/a/b",
            "Pod/ns/x",
        ] {
            assert!(CustomId::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn of_only_claims_custom_ids() {
        assert_eq!(CustomId::of("Pod/ns/web").unwrap(), None);
        assert!(CustomId::of("Custom/x/v1/K/ns/n").unwrap().is_some());
        assert!(CustomId::of("Custom/garbage").is_err());
    }

    #[test]
    fn builds_ids_and_splits_api_versions() {
        assert_eq!(
            custom_node_id("argoproj.io", "v1alpha1", "Rollout", Some("shop"), "web"),
            "Custom/argoproj.io/v1alpha1/Rollout/shop/web"
        );
        assert_eq!(custom_node_id("x.io", "v1", "Thing", None, "t"), "Custom/x.io/v1/Thing//t");
        assert_eq!(split_api_version("cert-manager.io/v1"), ("cert-manager.io", "v1"));
        assert_eq!(split_api_version("v1"), ("", "v1"));
    }

    #[test]
    fn names_that_could_inject_path_segments_are_rejected() {
        for bad in [
            "Custom/x.io/v1/Thing/ns/..",
            "Custom/x.io/v1/Thing/ns/.",
            "Custom/x.io/v1/Thing/ns/a%2Fb",
            "Custom/x.io/v1/Thing/ns/a?b",
            "Custom/x.io/v1/Thing/ns/A",
            "Custom/x.io/v1/Thing/n s/x",
            "Custom/x.io/v1/Thing/n.s/x",
            "Custom/x.io/v1/Thing/ns/-x",
            "Custom/x_y/v1/Thing/ns/x",
            "Custom/x.io/v1/Th%69ng/ns/x",
            "Custom/x.io/v1/Thing?/ns/x",
            "Custom/x.io/v1%2F/Thing/ns/x",
            "Custom/../v1/Thing/ns/x",
        ] {
            assert!(CustomId::parse(bad).is_err(), "{bad}");
        }
        let long = "a".repeat(254);
        assert!(CustomId::parse(&format!("Custom/x.io/v1/Thing/ns/{long}")).is_err());
        assert!(CustomId::parse("Custom/x.io/v1/Thing/ns/web.1-a").is_ok());
        assert!(CustomId::parse("Custom/x.io/v1alpha1/Thing/ns/x").is_ok());
    }
}
