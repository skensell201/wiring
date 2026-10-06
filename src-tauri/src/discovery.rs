//! Custom resource kinds the cluster serves
//! (spec: docs/superpowers/specs/2026-10-06-crds-helm-design.md).
//!
//! Discovery runs lazily, on the first `custom_kinds` call of a session, never at connect.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

/// Everything the dynamic API needs to reach one resource kind.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ResourceRef {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
}

impl ResourceRef {
    /// `group/version`, or just `version` for the core group.
    pub fn api_version(&self) -> String {
        if self.group.is_empty() {
            self.version.clone()
        } else {
            format!("{}/{}", self.group, self.version)
        }
    }
}

/// One `additionalPrinterColumns` entry of the served version; only priority-0 columns are
/// kept, as `kubectl get` shows them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterColumn {
    pub name: String,
    pub json_path: String,
    #[serde(rename = "type")]
    pub type_: String,
}

/// A listable custom kind and the columns its table shows besides Name/Namespace/Age.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomKind {
    pub resource: ResourceRef,
    pub columns: Vec<PrinterColumn>,
}

/// One served resource as discovery reports it, in the version it recommends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovered {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
}

/// What a CustomResourceDefinition contributes: its identity and printer columns per version.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CrdInfo {
    pub group: String,
    pub plural: String,
    pub columns: BTreeMap<String, Vec<PrinterColumn>>,
}

/// API groups that Kubernetes itself serves. They are never custom, and discovery skips them
/// (which also saves one request per group).
pub const BUILTIN_GROUPS: &[&str] = &[
    "",
    "admissionregistration.k8s.io",
    "apiextensions.k8s.io",
    "apiregistration.k8s.io",
    "apps",
    "authentication.k8s.io",
    "authorization.k8s.io",
    "autoscaling",
    "batch",
    "certificates.k8s.io",
    "coordination.k8s.io",
    "discovery.k8s.io",
    "events.k8s.io",
    "flowcontrol.apiserver.k8s.io",
    "internal.apiserver.k8s.io",
    "metrics.k8s.io",
    "networking.k8s.io",
    "node.k8s.io",
    "policy",
    "rbac.authorization.k8s.io",
    "resource.k8s.io",
    "scheduling.k8s.io",
    "storage.k8s.io",
    "storagemigration.k8s.io",
];

/// The custom kinds among `found`: listable, outside the built-in groups, and (when the CRDs
/// could be read) backed by a CRD, which rules out aggregated API servers. With the CRDs
/// known, each kind gets the printer columns of its served version. Sorted by group, then
/// kind; a kind discovered in several versions keeps the first one.
pub fn classify(found: &[Discovered], crds: Option<&[CrdInfo]>) -> Vec<CustomKind> {
    let mut seen: HashSet<(&str, &str)> = HashSet::new();
    let mut kinds: Vec<CustomKind> = Vec::new();
    for d in found {
        if BUILTIN_GROUPS.contains(&d.group.as_str()) || !d.verbs.iter().any(|v| v == "list") {
            continue;
        }
        let crd = crds.map(|crds| crds.iter().find(|c| c.group == d.group && c.plural == d.plural));
        let columns = match crd {
            Some(None) => continue, // CRDs are known and none defines this: not a custom resource
            Some(Some(c)) => c.columns.get(&d.version).cloned().unwrap_or_default(),
            None => Vec::new(),
        };
        if !seen.insert((d.group.as_str(), d.kind.as_str())) {
            continue;
        }
        kinds.push(CustomKind {
            resource: ResourceRef {
                group: d.group.clone(),
                version: d.version.clone(),
                kind: d.kind.clone(),
                plural: d.plural.clone(),
                namespaced: d.namespaced,
            },
            columns,
        });
    }
    kinds.sort_by(|a, b| (&a.resource.group, &a.resource.kind).cmp(&(&b.resource.group, &b.resource.kind)));
    kinds
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(group: &str, version: &str, kind: &str, plural: &str, namespaced: bool, verbs: &[&str]) -> Discovered {
        Discovered {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
            plural: plural.into(),
            namespaced,
            verbs: verbs.iter().map(|v| v.to_string()).collect(),
        }
    }

    fn crd(group: &str, plural: &str, version: &str, columns: &[(&str, &str, &str)]) -> CrdInfo {
        CrdInfo {
            group: group.into(),
            plural: plural.into(),
            columns: [(
                version.to_string(),
                columns
                    .iter()
                    .map(|(name, path, ty)| PrinterColumn {
                        name: name.to_string(),
                        json_path: path.to_string(),
                        type_: ty.to_string(),
                    })
                    .collect(),
            )]
            .into_iter()
            .collect(),
        }
    }

    const LW: &[&str] = &["get", "list", "watch", "create", "update", "delete"];

    #[test]
    fn built_in_groups_are_not_custom() {
        let kinds = classify(
            &[
                found("apps", "v1", "Deployment", "deployments", true, LW),
                found("", "v1", "Pod", "pods", true, LW),
                found("networking.k8s.io", "v1", "Ingress", "ingresses", true, LW),
            ],
            None,
        );
        assert!(kinds.is_empty(), "{kinds:?}");
    }

    #[test]
    fn a_custom_kind_keeps_scope_plural_and_version() {
        let kinds = classify(
            &[
                found("cert-manager.io", "v1", "Certificate", "certificates", true, LW),
                found("cert-manager.io", "v1", "ClusterIssuer", "clusterissuers", false, LW),
            ],
            None,
        );
        assert_eq!(
            kinds
                .iter()
                .map(|k| (&k.resource.kind[..], &k.resource.plural[..], k.resource.namespaced))
                .collect::<Vec<_>>(),
            vec![("Certificate", "certificates", true), ("ClusterIssuer", "clusterissuers", false)]
        );
        assert_eq!(kinds[0].resource.version, "v1");
        assert!(kinds[0].columns.is_empty(), "no CRD access: Name/Age only");
    }

    #[test]
    fn kinds_that_cannot_be_listed_are_skipped() {
        let kinds = classify(&[found("example.com", "v1", "Token", "tokens", true, &["create"])], None);
        assert!(kinds.is_empty());
    }

    #[test]
    fn with_crds_known_only_crd_backed_kinds_are_custom() {
        let kinds = classify(
            &[
                found("cert-manager.io", "v1", "Certificate", "certificates", true, LW),
                // An aggregated API server, not a CRD.
                found("custom.metrics.k8s.io", "v1beta2", "MetricValueList", "pods", true, LW),
                // CRD-backed even though the group ends in k8s.io.
                found("gateway.networking.k8s.io", "v1", "Gateway", "gateways", true, LW),
            ],
            Some(&[
                crd(
                    "cert-manager.io",
                    "certificates",
                    "v1",
                    &[("Ready", ".status.conditions[?(@.type==\"Ready\")].status", "string")],
                ),
                crd("gateway.networking.k8s.io", "gateways", "v1", &[]),
            ]),
        );
        let names: Vec<&str> = kinds.iter().map(|k| k.resource.kind.as_str()).collect();
        assert_eq!(names, vec!["Certificate", "Gateway"]);
        assert_eq!(kinds[0].columns[0].name, "Ready");
    }

    #[test]
    fn printer_columns_come_from_the_served_version() {
        let mut info = crd("example.com", "widgets", "v1", &[("Size", ".spec.size", "string")]);
        info.columns.insert("v2".into(), vec![]);
        let kinds = classify(&[found("example.com", "v2", "Widget", "widgets", true, LW)], Some(&[info]));
        assert!(kinds[0].columns.is_empty(), "v2 has no columns, v1's must not leak in");
    }

    #[test]
    fn kinds_are_sorted_by_group_then_kind_and_deduplicated() {
        let kinds = classify(
            &[
                found("b.example.com", "v1", "Zed", "zeds", true, LW),
                found("a.example.com", "v1", "Beta", "betas", true, LW),
                found("a.example.com", "v1", "Alpha", "alphas", true, LW),
                found("a.example.com", "v1beta1", "Alpha", "alphas", true, LW),
            ],
            None,
        );
        let ids: Vec<String> = kinds.iter().map(|k| format!("{}/{}", k.resource.group, k.resource.kind)).collect();
        assert_eq!(ids, vec!["a.example.com/Alpha", "a.example.com/Beta", "b.example.com/Zed"]);
        assert_eq!(kinds[0].resource.version, "v1", "the first (preferred) version wins");
    }
}
