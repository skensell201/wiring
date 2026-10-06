//! YAML manifest -> validated `Manifest`. Pure: no client, no store.

use serde::Deserialize;
use serde_json::Value;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::session::parse_node_id;
use crate::store::Kind;

/// One parsed Kubernetes object: the identity fields the commands need plus the full body.
#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub kind: Kind,
    pub name: String,
    pub namespace: Option<String>,
    pub body: serde_json::Value,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Invalid, message)
}

/// One parsed object of any kind (custom resources included), before its kind is resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct RawManifest {
    pub api_version: Option<String>,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub body: serde_json::Value,
}

/// Parse exactly one YAML document with a `kind` and a `metadata.name`.
pub fn parse_raw(yaml: &str) -> AppResult<RawManifest> {
    parse_raw_with(yaml, |name| {
        if crate::custom::id::is_path_segment_name(name) {
            Ok(())
        } else {
            Err(invalid(format!("metadata.name `{name}` is not a valid object name")))
        }
    })
}

fn parse_raw_with(yaml: &str, check_name: impl Fn(&str) -> AppResult<()>) -> AppResult<RawManifest> {
    let mut docs = Vec::new();
    for doc in serde_yaml_ng::Deserializer::from_str(yaml) {
        let value = serde_json::Value::deserialize(doc).map_err(|e| invalid(format!("YAML parse error: {e}")))?;
        if !value.is_null() {
            docs.push(value);
        }
    }
    let body = match docs.len() {
        0 => return Err(invalid("manifest is empty")),
        1 => docs.remove(0),
        _ => return Err(invalid("one object per manifest; the YAML contains several documents")),
    };
    if !body.is_object() {
        return Err(invalid("manifest must be a YAML mapping"));
    }
    let kind = body
        .get("kind")
        .and_then(|k| k.as_str())
        .ok_or_else(|| invalid("`kind` is missing"))?
        .to_string();
    let api_version = body.get("apiVersion").and_then(Value::as_str).map(str::to_owned);
    let metadata = body.get("metadata").filter(|m| m.is_object());
    let name = match metadata.and_then(|m| m.get("name")) {
        None | Some(Value::Null) => return Err(invalid("`metadata.name` is missing")),
        Some(Value::String(name)) if name.is_empty() => return Err(invalid("`metadata.name` is missing")),
        Some(Value::String(name)) => name.clone(),
        Some(_) => return Err(invalid("metadata.name must be a string")),
    };
    check_name(&name)?;
    let namespace = match metadata.and_then(|m| m.get("namespace")) {
        None | Some(Value::Null) => None,
        Some(Value::String(ns)) if ns.is_empty() => None,
        Some(Value::String(ns)) => Some(ns.clone()),
        Some(_) => return Err(invalid("metadata.namespace must be a string")),
    };
    if let Some(ns) = &namespace {
        validate_dns_subdomain("metadata.namespace", ns)?;
    }
    Ok(RawManifest {
        api_version,
        kind,
        name,
        namespace,
        body,
    })
}

/// Parse exactly one YAML document with a watched `kind` and a `metadata.name`.
pub fn parse(yaml: &str) -> AppResult<Manifest> {
    let raw = parse_raw_with(yaml, |name| validate_dns_subdomain("metadata.name", name))?;
    let kind = Kind::parse(&raw.kind).ok_or_else(|| invalid(format!("kind {} is not supported", raw.kind)))?;
    Ok(Manifest {
        kind,
        name: raw.name,
        namespace: raw.namespace,
        body: raw.body,
    })
}

const DNS_SUBDOMAIN_MAX: usize = 253;

/// RFC 1123 subdomain, as the API server requires for names and namespaces: lowercase
/// alphanumerics, `-` and `.`, at most 253 characters, starting and ending alphanumeric.
/// Catching it here gives a clearer message than the server's and never builds a URL from a
/// name containing `/`.
pub(crate) fn validate_dns_subdomain(field: &str, value: &str) -> AppResult<()> {
    let alnum = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let ok = value.len() <= DNS_SUBDOMAIN_MAX
        && value.chars().all(|c| alnum(c) || c == '-' || c == '.')
        && value.chars().next().is_some_and(alnum)
        && value.chars().last().is_some_and(alnum);
    if ok {
        Ok(())
    } else {
        Err(invalid(format!(
            "{field} `{value}` is not a valid DNS subdomain (lowercase letters, digits, `-` and `.`, \
             at most {DNS_SUBDOMAIN_MAX} characters, starting and ending with a letter or digit)"
        )))
    }
}

const DNS_LABEL_MAX: usize = 63;

/// RFC 1123 label, as the API server requires for namespace names: lowercase alphanumerics and
/// `-` (no `.`), at most 63 characters, starting and ending alphanumeric.
pub(crate) fn validate_dns_label(field: &str, value: &str) -> AppResult<()> {
    let alnum = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let ok = value.len() <= DNS_LABEL_MAX
        && value.chars().all(|c| alnum(c) || c == '-')
        && value.chars().next().is_some_and(alnum)
        && value.chars().last().is_some_and(alnum);
    if ok {
        Ok(())
    } else {
        Err(invalid(format!(
            "{field} `{value}` is not a valid DNS label (lowercase letters, digits and `-`, \
             at most {DNS_LABEL_MAX} characters, starting and ending with a letter or digit)"
        )))
    }
}

/// The manifest must describe the object `node_id` names: same kind, name and (for
/// namespaced kinds) namespace. Editing must never silently move or rename an object.
pub fn ensure_matches(m: &Manifest, node_id: &str) -> AppResult<()> {
    let (kind, ns, name) = parse_node_id(node_id).map_err(|e| invalid(e.message))?;
    if m.kind != kind {
        return Err(invalid(format!(
            "manifest kind {} does not match {} of the edited object",
            m.kind.as_str(),
            kind.as_str()
        )));
    }
    if m.name != name {
        return Err(invalid(format!(
            "manifest metadata.name `{}` does not match `{name}`; rename is not supported",
            m.name
        )));
    }
    if kind.is_cluster_scoped() {
        return Ok(());
    }
    let expected = ns.unwrap_or_default();
    match m.namespace.as_deref() {
        Some(actual) if actual == expected => Ok(()),
        Some(actual) => Err(invalid(format!(
            "manifest metadata.namespace `{actual}` does not match `{expected}`; moving is not supported"
        ))),
        None => Err(invalid(format!("manifest has no metadata.namespace; expected `{expected}`"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEPLOYMENT: &str = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: shop\nspec:\n  replicas: 3\n";

    #[test]
    fn parses_a_deployment() {
        let m = parse(DEPLOYMENT).unwrap();
        assert_eq!(m.kind, Kind::Deployment);
        assert_eq!(m.name, "web");
        assert_eq!(m.namespace.as_deref(), Some("shop"));
        assert_eq!(m.body["spec"]["replicas"], 3);
        assert_eq!(m.body["apiVersion"], "apps/v1");
    }

    #[test]
    fn cluster_scoped_manifest_has_no_namespace() {
        let m = parse("apiVersion: v1\nkind: PersistentVolume\nmetadata:\n  name: pv-1\n").unwrap();
        assert_eq!(m.kind, Kind::PersistentVolume);
        assert_eq!(m.namespace, None);
    }

    #[test]
    fn rejects_missing_kind_and_name() {
        let err = parse("apiVersion: v1\nmetadata:\n  name: x\n").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.contains("kind"), "{}", err.message);

        let err = parse("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  namespace: x\n").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.contains("metadata.name"), "{}", err.message);
    }

    #[test]
    fn names_and_namespaces_must_be_dns_subdomains() {
        let with = |name: &str, ns: &str| format!("kind: ConfigMap\nmetadata:\n  name: {name}\n  namespace: {ns}\n");
        assert!(parse(&with("web-1.example", "shop")).is_ok());
        assert!(parse(&with(&"a".repeat(253), "shop")).is_ok());
        for bad in ["Web", "-web", "web-", "web_1", "a/b", "web.", &"a".repeat(254)] {
            let err = parse(&with(bad, "shop")).unwrap_err();
            assert_eq!(err.kind, ErrorKind::Invalid, "{bad}");
            assert!(err.message.starts_with("metadata.name "), "{bad}: {}", err.message);
            assert!(err.message.contains("DNS subdomain"), "{}", err.message);
        }
        let err = parse(&with("web", "Shop")).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.starts_with("metadata.namespace `Shop`"), "{}", err.message);
    }

    #[test]
    fn name_and_namespace_must_be_strings() {
        let err = parse("kind: ConfigMap\nmetadata:\n  name: 42\n").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "metadata.name must be a string");
        let err = parse("kind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: [a]\n").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "metadata.namespace must be a string");
        let m = parse("kind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: null\n").unwrap();
        assert_eq!(m.namespace, None);
    }

    #[test]
    fn rejects_unwatched_kind() {
        let err = parse("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: n1\n").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "kind Namespace is not supported");
    }

    #[test]
    fn rejects_multi_document_streams_and_empty_input() {
        let two = format!("{DEPLOYMENT}---\n{DEPLOYMENT}");
        let err = parse(&two).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.contains("one object per manifest"), "{}", err.message);

        let err = parse("# nothing here\n").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.contains("empty"), "{}", err.message);

        let err = parse("- just\n- a list\n").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
    }

    #[test]
    fn rejects_unparseable_yaml() {
        let err = parse("kind: [unclosed\n").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.starts_with("YAML parse error"), "{}", err.message);
    }

    #[test]
    fn matches_the_node_id_it_was_loaded_from() {
        let m = parse(DEPLOYMENT).unwrap();
        assert!(ensure_matches(&m, "Deployment/shop/web").is_ok());

        let err = ensure_matches(&m, "Deployment/shop/other").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.contains("metadata.name"), "{}", err.message);

        let err = ensure_matches(&m, "Deployment/store/web").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.contains("metadata.namespace"), "{}", err.message);

        let err = ensure_matches(&m, "StatefulSet/shop/web").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.contains("kind"), "{}", err.message);

        let err = ensure_matches(&m, "garbage").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
    }

    #[test]
    fn namespace_must_be_present_for_namespaced_kinds_only() {
        let m = parse("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n").unwrap();
        let err = ensure_matches(&m, "ConfigMap/shop/cfg").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.contains("no metadata.namespace"), "{}", err.message);

        let pv = parse("apiVersion: v1\nkind: PersistentVolume\nmetadata:\n  name: pv-1\n  namespace: ignored\n").unwrap();
        assert!(ensure_matches(&pv, "PersistentVolume//pv-1").is_ok());
    }

    #[test]
    fn parse_raw_accepts_any_kind_and_keeps_the_api_version() {
        let m = parse_raw("apiVersion: cert-manager.io/v1\nkind: Certificate\nmetadata:\n  name: web-tls\n  namespace: shop\nspec: {}\n")
            .unwrap();
        assert_eq!(m.api_version.as_deref(), Some("cert-manager.io/v1"));
        assert_eq!(
            (m.kind.as_str(), m.name.as_str(), m.namespace.as_deref()),
            ("Certificate", "web-tls", Some("shop"))
        );
        assert!(
            parse("apiVersion: cert-manager.io/v1\nkind: Certificate\nmetadata:\n  name: web-tls\n")
                .unwrap_err()
                .message
                .contains("not supported")
        );
    }

    #[test]
    fn raw_manifests_accept_path_segment_names_but_built_ins_stay_dns() {
        let yaml = "apiVersion: x.io/v1\nkind: Thing\nmetadata:\n  name: Web:TLS\n  namespace: shop\n";
        assert_eq!(parse_raw(yaml).unwrap().name, "Web:TLS");
        assert!(parse_raw(&yaml.replace("Web:TLS", "a/b")).is_err());
        let cm = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: Web:TLS\n";
        assert!(parse(cm).is_err());
    }
}
