//! YAML manifest -> validated `Manifest`. Pure: no client, no store.

use serde::Deserialize;

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

/// Parse exactly one YAML document with a watched `kind` and a `metadata.name`.
pub fn parse(yaml: &str) -> AppResult<Manifest> {
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
    let kind_str = body
        .get("kind")
        .and_then(|k| k.as_str())
        .ok_or_else(|| invalid("`kind` is missing"))?;
    let kind = Kind::parse(kind_str).ok_or_else(|| invalid(format!("kind {kind_str} is not supported")))?;
    let metadata = body.get("metadata").filter(|m| m.is_object());
    let name = metadata
        .and_then(|m| m.get("name"))
        .and_then(|n| n.as_str())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| invalid("`metadata.name` is missing"))?
        .to_owned();
    let namespace = metadata
        .and_then(|m| m.get("namespace"))
        .and_then(|n| n.as_str())
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    Ok(Manifest {
        kind,
        name,
        namespace,
        body,
    })
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
    fn rejects_unwatched_kind() {
        let err = parse("apiVersion: v1\nkind: Node\nmetadata:\n  name: n1\n").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "kind Node is not supported");
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
}
