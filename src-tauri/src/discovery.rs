//! Custom resource kinds the cluster serves
//! (spec: docs/superpowers/specs/2026-10-06-crds-helm-design.md).
//!
//! Discovery runs lazily, on the first `custom_kinds` call of a session, never at connect.

use std::collections::{BTreeMap, HashSet};

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, ListParams};
use kube::discovery::{verbs, Discovery, Scope};
use kube::Client;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

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

/// The custom kind `group`/`kind`, addressed at `version` when one is given (an ownerReference
/// or a manifest may name a served version other than the one discovery recommends; plural and
/// scope are the same in every version).
pub fn find_kind(kinds: &[CustomKind], group: &str, version: &str, kind: &str) -> Option<CustomKind> {
    let mut found = kinds.iter().find(|k| k.resource.group == group && k.resource.kind == kind)?.clone();
    if !version.is_empty() {
        found.resource.version = version.to_owned();
    }
    Some(found)
}

/// Identity and priority-0 printer columns of each CRD, per version.
pub fn crd_infos(crds: &[CustomResourceDefinition]) -> Vec<CrdInfo> {
    crds.iter()
        .map(|crd| CrdInfo {
            group: crd.spec.group.clone(),
            plural: crd.spec.names.plural.clone(),
            columns: crd
                .spec
                .versions
                .iter()
                .map(|v| {
                    let columns = v
                        .additional_printer_columns
                        .iter()
                        .flatten()
                        .filter(|c| c.priority.unwrap_or(0) == 0)
                        .map(|c| PrinterColumn {
                            name: c.name.clone(),
                            json_path: c.json_path.clone(),
                            type_: c.type_.clone(),
                        })
                        .collect();
                    (v.name.clone(), columns)
                })
                .collect(),
        })
        .collect()
}

/// The custom kinds the CRDs define, with no group discovery: the storage version when it is
/// served (else the first served one), the CRD's plural, scope and kind, and the printer
/// columns of that version. CRDs with no served version are skipped.
pub fn kinds_from_crds(crds: &[CustomResourceDefinition]) -> Vec<CustomKind> {
    let found: Vec<Discovered> = crds
        .iter()
        .filter_map(|crd| {
            let served = || crd.spec.versions.iter().filter(|v| v.served);
            let version = served().find(|v| v.storage).or_else(|| served().next())?;
            Some(Discovered {
                group: crd.spec.group.clone(),
                version: version.name.clone(),
                kind: crd.spec.names.kind.clone(),
                plural: crd.spec.names.plural.clone(),
                namespaced: crd.spec.scope == "Namespaced",
                verbs: vec!["list".to_string()],
            })
        })
        .collect();
    classify(&found, Some(&crd_infos(crds)))
}

/// Flatten per-group discovery results, skipping the groups that failed (an unavailable
/// APIService must not hide every other group).
pub fn collect_groups<E: std::fmt::Display>(groups: Vec<(String, Result<Vec<Discovered>, E>)>) -> Vec<Discovered> {
    let mut found = Vec::new();
    for (group, result) in groups {
        match result {
            Ok(mut d) => found.append(&mut d),
            Err(e) => tracing::debug!("discovery of group {group} failed, skipping: {e}"),
        }
    }
    found
}

/// Whether a failed aggregated discovery request means "not supported or unparseable" (so
/// per-group discovery may work) rather than an auth, authorization, network or server error,
/// which would fail the fallback too.
pub fn aggregated_unsupported(e: &kube::Error) -> bool {
    match e {
        kube::Error::Api(status) => matches!(status.code, 400 | 404 | 405 | 406 | 415),
        kube::Error::SerdeError(_) => true,
        _ => false,
    }
}

fn discovered_in(group: &kube::discovery::ApiGroup) -> Vec<Discovered> {
    group
        .recommended_resources()
        .into_iter()
        .map(|(ar, caps)| Discovered {
            group: ar.group.clone(),
            version: ar.version.clone(),
            kind: ar.kind.clone(),
            plural: ar.plural.clone(),
            namespaced: caps.scope == Scope::Namespaced,
            verbs: if caps.supports_operation(verbs::LIST) {
                caps.operations.clone()
            } else {
                Vec::new()
            },
        })
        .collect()
}

/// Discover the custom kinds the user can list. The CRDs alone are enough when the user may
/// list them. Otherwise (no CRD access) kinds come from group discovery, which gets Name/Age
/// only: aggregated discovery (two requests), or on servers without it one request per group,
/// skipping groups that fail. Auth, authorization and network errors are returned.
pub async fn discover(client: Client) -> AppResult<Vec<CustomKind>> {
    match Api::<CustomResourceDefinition>::all(client.clone())
        .list(&ListParams::default())
        .await
    {
        Ok(list) => return Ok(kinds_from_crds(&list.items)),
        Err(e @ (kube::Error::Auth(_) | kube::Error::HyperError(_) | kube::Error::Service(_))) => return Err(AppError::from(&e)),
        Err(kube::Error::Api(s)) if s.code == 401 => return Err(AppError::from(&kube::Error::Api(s))),
        Err(_) => {}
    }
    let mut found = Vec::new();
    match Discovery::new(client.clone()).exclude(BUILTIN_GROUPS).run_aggregated().await {
        Ok(d) => d.groups().for_each(|g| found.extend(discovered_in(g))),
        Err(e) if aggregated_unsupported(&e) => {
            let names: Vec<String> = client
                .list_api_groups()
                .await
                .map_err(|e| AppError::from(&e))?
                .groups
                .into_iter()
                .map(|g| g.name)
                .filter(|n| !BUILTIN_GROUPS.contains(&n.as_str()))
                .collect();
            let mut results = Vec::new();
            for name in names {
                let r = kube::discovery::oneshot::group(&client, &name).await.map(|g| discovered_in(&g));
                results.push((name, r));
            }
            found = collect_groups(results);
        }
        Err(e) => return Err(AppError::from(&e)),
    }
    Ok(classify(&found, None))
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

    #[test]
    fn find_kind_matches_group_and_kind_and_takes_the_ids_version() {
        let kinds = classify(&[found("argoproj.io", "v1alpha1", "Rollout", "rollouts", true, LW)], None);
        let k = find_kind(&kinds, "argoproj.io", "v1beta1", "Rollout").unwrap();
        assert_eq!(k.resource.version, "v1beta1");
        assert_eq!(k.resource.plural, "rollouts");
        assert_eq!(
            find_kind(&kinds, "argoproj.io", "", "Rollout").unwrap().resource.version,
            "v1alpha1"
        );
        assert!(find_kind(&kinds, "other.io", "v1", "Rollout").is_none());
    }

    #[test]
    fn crd_infos_keep_priority_zero_columns_per_version() {
        use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
        let crd: CustomResourceDefinition = serde_json::from_value(serde_json::json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": { "name": "certificates.cert-manager.io" },
            "spec": {
                "group": "cert-manager.io",
                "scope": "Namespaced",
                "names": { "plural": "certificates", "singular": "certificate", "kind": "Certificate" },
                "versions": [
                    { "name": "v1", "served": true, "storage": true, "additionalPrinterColumns": [
                        { "name": "Ready", "type": "string", "jsonPath": ".status.conditions[?(@.type==\"Ready\")].status" },
                        { "name": "Secret", "type": "string", "jsonPath": ".spec.secretName" },
                        { "name": "Issuer", "type": "string", "jsonPath": ".spec.issuerRef.name", "priority": 1 },
                        { "name": "Age", "type": "date", "jsonPath": ".metadata.creationTimestamp" }
                    ] },
                    { "name": "v1beta1", "served": false, "storage": false }
                ]
            }
        }))
        .unwrap();
        let infos = crd_infos(&[crd]);
        assert_eq!(infos.len(), 1);
        assert_eq!((&infos[0].group[..], &infos[0].plural[..]), ("cert-manager.io", "certificates"));
        let v1: Vec<&str> = infos[0].columns["v1"].iter().map(|c| c.name.as_str()).collect();
        assert_eq!(v1, vec!["Ready", "Secret", "Age"], "priority 1 is a wide-only column");
        assert_eq!(infos[0].columns["v1"][2].type_, "date");
        assert!(infos[0].columns["v1beta1"].is_empty());
    }

    fn crd_json(group: &str, plural: &str, kind: &str, scope: &str, versions: serde_json::Value) -> CustomResourceDefinition {
        serde_json::from_value(serde_json::json!({
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": { "name": format!("{plural}.{group}") },
            "spec": { "group": group, "scope": scope,
                      "names": { "plural": plural, "singular": plural, "kind": kind },
                      "versions": versions }
        }))
        .unwrap()
    }

    #[test]
    fn kinds_are_built_from_crds_alone() {
        let crds = [
            crd_json(
                "example.com",
                "widgets",
                "Widget",
                "Namespaced",
                serde_json::json!([
                    { "name": "v1alpha1", "served": true, "storage": false },
                    { "name": "v1", "served": true, "storage": true,
                      "additionalPrinterColumns": [{ "name": "Size", "type": "string", "jsonPath": ".spec.size" }] },
                    { "name": "v0", "served": false, "storage": false }
                ]),
            ),
            crd_json(
                "example.com",
                "clusterthings",
                "ClusterThing",
                "Cluster",
                serde_json::json!([{ "name": "v2", "served": true, "storage": false }, { "name": "v1", "served": true, "storage": true }]),
            ),
            crd_json(
                "example.com",
                "gone",
                "Gone",
                "Namespaced",
                serde_json::json!([{ "name": "v1", "served": false, "storage": true }]),
            ),
        ];
        let kinds = kinds_from_crds(&crds);
        let names: Vec<(&str, &str, bool)> = kinds
            .iter()
            .map(|k| (k.resource.kind.as_str(), k.resource.version.as_str(), k.resource.namespaced))
            .collect();
        assert_eq!(
            names,
            vec![("ClusterThing", "v1", false), ("Widget", "v1", true)],
            "storage version wins; unserved CRDs are skipped"
        );
        assert_eq!(kinds[1].resource.plural, "widgets");
        assert_eq!(kinds[1].columns[0].name, "Size");
    }

    #[test]
    fn a_failing_group_does_not_hide_the_others() {
        let ok = |kind: &str| Ok(vec![found("a.example.com", "v1", kind, "things", true, LW)]);
        let groups: Vec<(String, Result<Vec<Discovered>, String>)> = vec![
            ("a.example.com".into(), ok("Alpha")),
            ("custom.metrics.k8s.io".into(), Err("503 service unavailable".into())),
            ("b.example.com".into(), ok("Beta")),
        ];
        let all = collect_groups(groups);
        assert_eq!(all.iter().map(|d| d.kind.as_str()).collect::<Vec<_>>(), vec!["Alpha", "Beta"]);
    }

    #[test]
    fn only_an_unsupported_aggregated_reply_falls_back() {
        let api = |code: u16| kube::Error::Api(kube::core::Status::failure("x", "y").with_code(code).boxed());
        assert!(aggregated_unsupported(&api(404)));
        assert!(aggregated_unsupported(&api(406)));
        assert!(!aggregated_unsupported(&api(401)));
        assert!(!aggregated_unsupported(&api(403)));
        assert!(!aggregated_unsupported(&api(500)));
    }
}
