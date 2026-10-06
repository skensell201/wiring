//! Helm 3 releases, read-only, from their storage Secrets (`type: helm.sh/release.v1`)
//! (spec: docs/superpowers/specs/2026-10-06-crds-helm-design.md).
//!
//! A record is `data.release` = base64(base64(gzip(json))). k8s-openapi undoes the Secret's own
//! base64, so the bytes here are base64(gzip(json)). Values can hold credentials: nothing
//! decoded here is ever logged, and errors never echo a record.

use std::collections::BTreeMap;
use std::io::Read;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::read::GzDecoder;
use k8s_openapi::api::core::v1::Secret;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::{node_id, NodeId, Status};
use crate::store::{Kind, Object, Store};

pub const STORAGE_TYPE: &str = "helm.sh/release.v1";
const GZIP_MAGIC: [u8; 3] = [0x1f, 0x8b, 0x08];
/// Cap on the inflated record (a Secret is at most 1 MiB compressed; real releases are far
/// smaller than this), so a crafted gzip cannot exhaust memory.
const MAX_DECODED_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default, Deserialize)]
#[serde(default)]
pub(crate) struct RawRelease {
    pub name: String,
    pub namespace: String,
    pub version: i64,
    pub info: RawInfo,
    pub chart: RawChart,
    pub config: Option<Value>,
}

/// `config` (the user's values) can hold credentials, so Debug never prints it.
impl std::fmt::Debug for RawRelease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RawRelease")
            .field("name", &self.name)
            .field("namespace", &self.namespace)
            .field("version", &self.version)
            .field("status", &self.info.status)
            .field(
                "chart",
                &format_args!("{} {}", self.chart.metadata.name, self.chart.metadata.version),
            )
            .field("config", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct RawInfo {
    pub first_deployed: Option<String>,
    pub last_deployed: Option<String>,
    pub description: String,
    pub status: String,
    pub notes: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct RawChart {
    pub metadata: RawChartMeta,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct RawChartMeta {
    pub name: String,
    pub version: String,
    pub app_version: String,
}

fn corrupt() -> AppError {
    AppError::new(ErrorKind::Invalid, "the Helm release record could not be decoded")
}

/// base64 → (gzip, when the magic bytes say so) → JSON.
pub(crate) fn decode(payload: &[u8]) -> AppResult<RawRelease> {
    decode_with_limit(payload, MAX_DECODED_BYTES)
}

fn decode_with_limit(payload: &[u8], limit: usize) -> AppResult<RawRelease> {
    let bytes = STANDARD.decode(payload.trim_ascii()).map_err(|_| corrupt())?;
    let json = if bytes.starts_with(&GZIP_MAGIC) {
        let mut out = Vec::new();
        GzDecoder::new(bytes.as_slice())
            .take(limit as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|_| corrupt())?;
        if out.len() > limit {
            return Err(corrupt());
        }
        out
    } else {
        bytes
    };
    serde_json::from_slice(&json).map_err(|_| corrupt())
}

pub(crate) fn decode_secret(secret: &Secret) -> AppResult<RawRelease> {
    let payload = secret.data.as_ref().and_then(|d| d.get("release")).ok_or_else(corrupt)?;
    decode(&payload.0)
}

pub fn is_storage_secret(obj: &Object) -> bool {
    matches!(obj, Object::Secret(s) if s.type_.as_deref() == Some(STORAGE_TYPE))
}

/// `deployed` ok; `pending-*` and `uninstalling` warn; `failed` err; the rest (superseded,
/// uninstalled, unknown) unknown.
pub fn health(status: &str) -> Status {
    match status {
        "deployed" => Status::Ok,
        "failed" => Status::Err,
        s if s.starts_with("pending-") || s == "uninstalling" => Status::Warn,
        _ => Status::Unknown,
    }
}

/// A release's latest revision, as one row of the releases list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    /// `name-version`, as `helm list` shows it.
    pub chart: String,
    pub app_version: String,
    pub revision: i64,
    pub status: String,
    pub health: Status,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmRevision {
    pub revision: i64,
    pub chart: String,
    pub app_version: String,
    pub status: String,
    pub health: Status,
    pub updated: Option<String>,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmReleaseDetails {
    pub release: HelmRelease,
    pub description: String,
    pub first_deployed: Option<String>,
    pub last_deployed: Option<String>,
    /// The user-supplied values as YAML; empty when none were given.
    pub values: String,
    pub notes: String,
    /// Every stored revision, newest first.
    pub history: Vec<HelmRevision>,
    /// The release's objects that exist in the cluster (in the scope), as node ids.
    pub resources: Vec<NodeId>,
}

/// A storage Secret with the release name and revision from its labels.
struct Stored<'a> {
    namespace: &'a str,
    name: &'a str,
    revision: i64,
    secret: &'a Secret,
}

fn stored(store: &Store) -> Vec<Stored<'_>> {
    store
        .iter_kind(Kind::Secret)
        .filter_map(|obj| {
            let Object::Secret(secret) = obj else { return None };
            if secret.type_.as_deref() != Some(STORAGE_TYPE) {
                return None;
            }
            let labels = secret.metadata.labels.as_ref()?;
            Some(Stored {
                namespace: obj.namespace()?,
                name: labels.get("name")?.as_str(),
                revision: labels.get("version")?.parse().ok()?,
                secret,
            })
        })
        .collect()
}

fn chart_of(raw: &RawRelease) -> String {
    format!("{}-{}", raw.chart.metadata.name, raw.chart.metadata.version)
}

fn row_of(raw: &RawRelease, namespace: &str) -> HelmRelease {
    HelmRelease {
        name: raw.name.clone(),
        namespace: if raw.namespace.is_empty() {
            namespace.to_owned()
        } else {
            raw.namespace.clone()
        },
        chart: chart_of(raw),
        app_version: raw.chart.metadata.app_version.clone(),
        revision: raw.version,
        status: raw.info.status.clone(),
        health: health(&raw.info.status),
        updated: raw.info.last_deployed.clone(),
    }
}

fn revision_of(raw: &RawRelease) -> HelmRevision {
    HelmRevision {
        revision: raw.version,
        chart: chart_of(raw),
        app_version: raw.chart.metadata.app_version.clone(),
        status: raw.info.status.clone(),
        health: health(&raw.info.status),
        updated: raw.info.last_deployed.clone(),
        description: raw.info.description.clone(),
    }
}

/// The record, if it decodes and agrees with the Secret's labels and namespace. Only names
/// and the revision are logged; the record itself and decode errors never are.
fn decoded(s: &Stored<'_>) -> Option<RawRelease> {
    let raw = decode_secret(s.secret)
        .ok()
        .filter(|raw| raw.name == s.name && (raw.namespace.is_empty() || raw.namespace == s.namespace));
    if raw.is_none() {
        tracing::warn!(
            namespace = s.namespace,
            release = s.name,
            revision = s.revision,
            "undecodable Helm release record"
        );
    }
    raw
}

/// The latest revision of every release in the store, sorted by namespace and name.
pub fn releases(store: &Store) -> Vec<HelmRelease> {
    let mut latest: BTreeMap<(&str, &str), Stored<'_>> = BTreeMap::new();
    for s in stored(store) {
        let key = (s.namespace, s.name);
        if latest.get(&key).is_none_or(|cur| cur.revision < s.revision) {
            latest.insert(key, s);
        }
    }
    latest
        .values()
        .filter_map(|s| decoded(s).map(|raw| row_of(&raw, s.namespace)))
        .collect()
}

/// Overview, values, history, notes and member objects of one release.
pub fn release(store: &Store, namespace: &str, name: &str) -> AppResult<HelmReleaseDetails> {
    // Each revision is reduced to its history row at once; only the newest keeps its full record.
    let mut history = Vec::new();
    let mut latest: Option<RawRelease> = None;
    for s in stored(store).iter().filter(|s| s.namespace == namespace && s.name == name) {
        let Some(raw) = decoded(s) else { continue };
        history.push(revision_of(&raw));
        if latest.as_ref().is_none_or(|cur| cur.version < raw.version) {
            latest = Some(raw);
        }
    }
    history.sort_by_key(|h| std::cmp::Reverse(h.revision));
    let latest = latest.ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("Helm release {namespace}/{name} not found")))?;
    let values = match &latest.config {
        None | Some(Value::Null) => String::new(),
        Some(Value::Object(m)) if m.is_empty() => String::new(),
        Some(v) => serde_yaml_ng::to_string(v).map_err(|e| AppError::internal(e.to_string()))?,
    };
    Ok(HelmReleaseDetails {
        release: row_of(&latest, namespace),
        description: latest.info.description,
        first_deployed: latest.info.first_deployed,
        last_deployed: latest.info.last_deployed,
        values,
        notes: latest.info.notes,
        history,
        resources: members(store, namespace, name),
    })
}

/// Helm's ownership annotations (these name the release's namespace, so objects installed into
/// another namespace still belong), or `managed-by: Helm` + `instance` labels in the release's
/// namespace (cluster-scoped objects have none, so the labels alone decide for them).
fn belongs(obj: &Object, namespace: &str, name: &str) -> bool {
    let meta = obj.meta();
    let annotation = |k: &str| meta.annotations.as_ref().and_then(|a| a.get(k)).map(String::as_str);
    if let Some(release) = annotation("meta.helm.sh/release-name") {
        let release_ns = annotation("meta.helm.sh/release-namespace").or(obj.namespace());
        return release == name && release_ns == Some(namespace);
    }
    let label = |k: &str| meta.labels.as_ref().and_then(|l| l.get(k)).map(String::as_str);
    label("app.kubernetes.io/managed-by") == Some("Helm")
        && label("app.kubernetes.io/instance") == Some(name)
        && obj.namespace().is_none_or(|ns| ns == namespace)
}

pub fn members(store: &Store, namespace: &str, name: &str) -> Vec<NodeId> {
    let mut ids: Vec<NodeId> = store
        .iter()
        .filter(|o| !is_storage_secret(o) && belongs(o, namespace, name))
        .map(|o| node_id(o.kind(), o.namespace(), o.name()))
        .collect();
    ids.sort();
    ids
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use k8s_openapi::api::core::v1::Secret;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use k8s_openapi::ByteString;
    use serde_json::json;

    /// base64(gzip(json)): the bytes Helm puts under `data.release` *after* the Secret's own
    /// base64 is undone (k8s-openapi's `ByteString` already holds them decoded once).
    pub(crate) fn encode(release: &Value) -> Vec<u8> {
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(&serde_json::to_vec(release).unwrap()).unwrap();
        STANDARD.encode(gz.finish().unwrap()).into_bytes()
    }

    pub(crate) fn release_json(name: &str, ns: &str, version: i64, status: &str, chart_version: &str) -> Value {
        json!({
            "name": name, "namespace": ns, "version": version,
            "info": {
                "first_deployed": "2026-10-01T08:00:00Z", "last_deployed": format!("2026-10-0{version}T09:30:00Z"),
                "deleted": "", "description": format!("Revision {version}"), "status": status,
                "notes": "Visit http://web.shop\n"
            },
            "chart": { "metadata": { "name": "web", "version": chart_version, "appVersion": "2.0.1" }, "values": { "replicaCount": 1 } },
            "config": { "replicaCount": 2, "image": { "tag": "2.0.1" } },
            "manifest": "---\napiVersion: v1\nkind: ConfigMap\n"
        })
    }

    pub(crate) fn storage_secret(ns: &str, name: &str, version: i64, status: &str, release: &Value) -> Object {
        let labels = [
            ("name", name.to_string()),
            ("owner", "helm".into()),
            ("status", status.into()),
            ("version", version.to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        Object::Secret(Secret {
            metadata: ObjectMeta {
                name: Some(format!("sh.helm.release.v1.{name}.v{version}")),
                namespace: Some(ns.into()),
                labels: Some(labels),
                ..Default::default()
            },
            type_: Some(STORAGE_TYPE.into()),
            data: Some([("release".to_string(), ByteString(encode(release)))].into_iter().collect()),
            ..Default::default()
        })
    }

    #[test]
    fn decodes_a_release_record_from_a_real_secret_manifest() {
        // As `kubectl get secret -o json` shows it: data.release is base64(base64(gzip(json))).
        let rel = release_json("web", "shop", 3, "deployed", "1.4.2");
        let secret: Secret = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Secret", "type": STORAGE_TYPE,
            "metadata": { "name": "sh.helm.release.v1.web.v3", "namespace": "shop" },
            "data": { "release": STANDARD.encode(encode(&rel)) }
        }))
        .unwrap();
        let raw = decode_secret(&secret).unwrap();
        assert_eq!((raw.name.as_str(), raw.version, raw.info.status.as_str()), ("web", 3, "deployed"));
        assert_eq!(raw.chart.metadata.app_version, "2.0.1");
        assert_eq!(raw.config, Some(json!({ "replicaCount": 2, "image": { "tag": "2.0.1" } })));
    }

    #[test]
    fn an_uncompressed_record_decodes_too() {
        let rel = release_json("web", "shop", 1, "deployed", "1.0.0");
        let payload = STANDARD.encode(serde_json::to_vec(&rel).unwrap()).into_bytes();
        assert_eq!(decode(&payload).unwrap().version, 1);
    }

    #[test]
    fn a_corrupt_record_is_an_error_that_carries_no_payload() {
        let err = decode(b"not base64 at all!").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(!err.message.contains("not base64"), "the message must not echo the record");
        let gz_garbage = STANDARD.encode([0x1f, 0x8b, 0x08, 0, 1, 2, 3]).into_bytes();
        assert!(decode(&gz_garbage).is_err());
    }

    /// base64(gzip(`total - 2` spaces + `{}`)): valid JSON once inflated, `total` bytes long.
    fn padded_json(total: usize) -> Vec<u8> {
        let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
        let chunk = vec![b' '; 1 << 20];
        let mut left = total - 2;
        while left > 0 {
            let n = left.min(chunk.len());
            gz.write_all(&chunk[..n]).unwrap();
            left -= n;
        }
        gz.write_all(b"{}").unwrap();
        STANDARD.encode(gz.finish().unwrap()).into_bytes()
    }

    #[test]
    fn a_decompression_bomb_is_rejected_by_the_cap_alone() {
        // Valid JSON when uncapped, so only the size cap can reject it.
        let err = decode(&padded_json(MAX_DECODED_BYTES + 1)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
    }

    #[test]
    fn a_record_just_under_the_cap_decodes() {
        let rel = decode(&padded_json(MAX_DECODED_BYTES)).unwrap();
        assert_eq!(rel.version, 0);
    }

    #[test]
    fn debug_never_prints_the_values() {
        let mut v = release_json("web", "shop", 1, "deployed", "1.0.0");
        v["config"] = json!({ "password": "hunter2-secret" });
        let rel = decode(&encode(&v)).unwrap();
        let shown = format!("{rel:?}");
        assert!(!shown.contains("hunter2") && !shown.contains("password"), "{shown}");
        assert!(shown.contains("web") && shown.contains("<redacted>"));
    }

    #[test]
    fn status_mapping() {
        assert_eq!(health("deployed"), Status::Ok);
        for s in ["pending-install", "pending-upgrade", "pending-rollback", "uninstalling"] {
            assert_eq!(health(s), Status::Warn, "{s}");
        }
        assert_eq!(health("failed"), Status::Err);
        for s in ["superseded", "uninstalled", "unknown", ""] {
            assert_eq!(health(s), Status::Unknown, "{s}");
        }
    }

    #[test]
    fn storage_secrets_are_recognised() {
        let rel = release_json("web", "shop", 1, "deployed", "1.0.0");
        assert!(is_storage_secret(&storage_secret("shop", "web", 1, "deployed", &rel)));
        let plain = Object::Secret(Secret {
            type_: Some("Opaque".into()),
            ..Default::default()
        });
        assert!(!is_storage_secret(&plain));
    }

    use crate::store::Store;

    fn object(v: Value) -> Object {
        Object::from_json_value(v).unwrap()
    }

    fn store_with_web() -> Store {
        let mut s = Store::default();
        s.upsert(storage_secret(
            "shop",
            "web",
            1,
            "superseded",
            &release_json("web", "shop", 1, "superseded", "1.4.0"),
        ));
        s.upsert(storage_secret(
            "shop",
            "web",
            2,
            "superseded",
            &release_json("web", "shop", 2, "superseded", "1.4.1"),
        ));
        s.upsert(storage_secret(
            "shop",
            "web",
            3,
            "deployed",
            &release_json("web", "shop", 3, "deployed", "1.4.2"),
        ));
        s.upsert(storage_secret(
            "shop",
            "api",
            1,
            "failed",
            &release_json("api", "shop", 1, "failed", "0.1.0"),
        ));
        s.upsert(object(
            json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "web-cfg", "namespace": "shop",
            "annotations": { "meta.helm.sh/release-name": "web", "meta.helm.sh/release-namespace": "shop" } } }),
        ));
        s.upsert(object(
            json!({ "apiVersion": "apps/v1", "kind": "Deployment", "metadata": { "name": "web", "namespace": "shop",
            "labels": { "app.kubernetes.io/managed-by": "Helm", "app.kubernetes.io/instance": "web" } },
            "spec": { "selector": { "matchLabels": { "app": "web" } }, "template": { "metadata": { "labels": { "app": "web" } },
            "spec": { "containers": [{ "name": "web", "image": "nginx" }] } } } }),
        ));
        // Another release's object, and one claiming the web release of another namespace.
        s.upsert(object(
            json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "api-cfg", "namespace": "shop",
            "annotations": { "meta.helm.sh/release-name": "api", "meta.helm.sh/release-namespace": "shop" } } }),
        ));
        s.upsert(object(
            json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "elsewhere", "namespace": "shop",
            "annotations": { "meta.helm.sh/release-name": "web", "meta.helm.sh/release-namespace": "other" } } }),
        ));
        // `instance` without `managed-by: Helm` is not membership.
        s.upsert(object(
            json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "kustomized", "namespace": "shop",
            "labels": { "app.kubernetes.io/instance": "web" } } }),
        ));
        s
    }

    #[test]
    fn the_list_has_the_latest_revision_per_release() {
        let list = releases(&store_with_web());
        let rows: Vec<(&str, &str, i64, &str, Status)> = list
            .iter()
            .map(|r| (r.name.as_str(), r.chart.as_str(), r.revision, r.status.as_str(), r.health))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("api", "web-0.1.0", 1, "failed", Status::Err),
                ("web", "web-1.4.2", 3, "deployed", Status::Ok)
            ]
        );
        assert_eq!(list[1].app_version, "2.0.1");
        assert_eq!(list[1].updated.as_deref(), Some("2026-10-03T09:30:00Z"));
        assert_eq!(list[1].namespace, "shop");
    }

    #[test]
    fn an_undecodable_record_is_skipped() {
        let mut s = store_with_web();
        let Object::Secret(mut broken) = storage_secret("shop", "bad", 1, "deployed", &json!({})) else {
            unreachable!()
        };
        broken.data = Some(
            [("release".to_string(), k8s_openapi::ByteString(b"%%%".to_vec()))]
                .into_iter()
                .collect(),
        );
        s.upsert(Object::Secret(broken));
        assert!(releases(&s).iter().all(|r| r.name != "bad"));
    }

    #[test]
    fn a_record_that_disagrees_with_its_labels_is_skipped() {
        let mut s = Store::default();
        // Labels say shop/web, the record says it is api (or lives in another namespace).
        s.upsert(storage_secret(
            "shop",
            "web",
            1,
            "deployed",
            &release_json("api", "shop", 1, "deployed", "1.0.0"),
        ));
        s.upsert(storage_secret(
            "shop",
            "db",
            1,
            "deployed",
            &release_json("db", "other", 1, "deployed", "1.0.0"),
        ));
        s.upsert(storage_secret(
            "shop",
            "ok",
            1,
            "deployed",
            &release_json("ok", "shop", 1, "deployed", "1.0.0"),
        ));
        let names: Vec<String> = releases(&s).into_iter().map(|r| r.name).collect();
        assert_eq!(names, vec!["ok".to_string()]);
        assert_eq!(release(&s, "shop", "web").unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn details_have_values_notes_history_newest_first_and_members() {
        let d = release(&store_with_web(), "shop", "web").unwrap();
        assert_eq!(d.release.revision, 3);
        assert_eq!(d.description, "Revision 3");
        assert_eq!(d.first_deployed.as_deref(), Some("2026-10-01T08:00:00Z"));
        assert_eq!(d.values, "replicaCount: 2\nimage:\n  tag: 2.0.1\n");
        assert_eq!(d.notes, "Visit http://web.shop\n");
        let history: Vec<(i64, &str, &str)> = d
            .history
            .iter()
            .map(|h| (h.revision, h.chart.as_str(), h.status.as_str()))
            .collect();
        assert_eq!(
            history,
            vec![
                (3, "web-1.4.2", "deployed"),
                (2, "web-1.4.1", "superseded"),
                (1, "web-1.4.0", "superseded")
            ]
        );
        assert_eq!(
            d.resources,
            vec!["ConfigMap/shop/web-cfg".to_string(), "Deployment/shop/web".to_string()]
        );
    }

    #[test]
    fn empty_values_render_as_nothing() {
        let mut rel = release_json("bare", "shop", 1, "deployed", "1.0.0");
        rel["config"] = json!({});
        let mut s = Store::default();
        s.upsert(storage_secret("shop", "bare", 1, "deployed", &rel));
        assert_eq!(release(&s, "shop", "bare").unwrap().values, "");
    }

    #[test]
    fn an_unknown_release_is_not_found() {
        assert_eq!(release(&store_with_web(), "shop", "nope").unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn membership_needs_the_release_and_its_namespace() {
        let s = store_with_web();
        assert_eq!(members(&s, "shop", "api"), vec!["ConfigMap/shop/api-cfg".to_string()]);
        // The annotation names the release's namespace, so an object installed into another
        // namespace is found from the release's own.
        assert_eq!(members(&s, "other", "web"), vec!["ConfigMap/shop/elsewhere".to_string()]);
        assert!(
            !members(&s, "shop", "web").contains(&"ConfigMap/shop/elsewhere".to_string()),
            "it claims other/web"
        );
        assert!(
            members(&s, "shop", "web").iter().all(|id| !id.starts_with("Secret/")),
            "storage Secrets are not members"
        );
    }
}
