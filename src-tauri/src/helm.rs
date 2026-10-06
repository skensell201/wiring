//! Helm 3 releases, read-only, from their storage Secrets (`type: helm.sh/release.v1`)
//! (spec: docs/superpowers/specs/2026-10-06-crds-helm-design.md).
//!
//! A record is `data.release` = base64(base64(gzip(json))). k8s-openapi undoes the Secret's own
//! base64, so the bytes here are base64(gzip(json)). Values can hold credentials: nothing
//! decoded here is ever logged, and errors never echo a record.

// Nothing outside the tests calls this module yet; Task 9 (release list/details) uses it.
// Remove this allow then.
#![allow(dead_code)]

use std::io::Read;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::read::GzDecoder;
use k8s_openapi::api::core::v1::Secret;
use serde::Deserialize;
use serde_json::Value;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::Status;
use crate::store::Object;

pub const STORAGE_TYPE: &str = "helm.sh/release.v1";
const GZIP_MAGIC: [u8; 3] = [0x1f, 0x8b, 0x08];
/// Cap on the inflated record (a Secret is at most 1 MiB compressed; real releases are far
/// smaller than this), so a crafted gzip cannot exhaust memory.
const MAX_DECODED_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct RawRelease {
    pub name: String,
    pub namespace: String,
    pub version: i64,
    pub info: RawInfo,
    pub chart: RawChart,
    pub config: Option<Value>,
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
    let bytes = STANDARD.decode(payload.trim_ascii()).map_err(|_| corrupt())?;
    let json = if bytes.starts_with(&GZIP_MAGIC) {
        let mut out = Vec::new();
        GzDecoder::new(bytes.as_slice())
            .take(MAX_DECODED_BYTES as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|_| corrupt())?;
        if out.len() > MAX_DECODED_BYTES {
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

    #[test]
    fn a_decompression_bomb_is_rejected() {
        // Zeros compress ~1000:1, so this is a ~33 KiB record that would inflate past the cap.
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        let chunk = vec![0u8; 1 << 20];
        for _ in 0..(MAX_DECODED_BYTES / chunk.len() + 1) {
            gz.write_all(&chunk).unwrap();
        }
        let payload = STANDARD.encode(gz.finish().unwrap()).into_bytes();
        assert!(decode(&payload).is_err());
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
}
