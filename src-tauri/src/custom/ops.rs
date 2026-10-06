//! Dynamic-API access to custom resources. Requests go through a [`Source`] (the real one
//! wraps a cloned `Client`), so callers never hold the session lock across them and tests
//! script the cluster.

use futures::future::{join_all, BoxFuture};
use futures::stream::BoxStream;
use futures::{FutureExt, StreamExt};
use kube::api::{Api, ListParams, PostParams};
use kube::core::{ApiResource, DynamicObject, Request, Resource};
use kube::runtime::watcher::{self, watcher, Event};
use kube::runtime::WatchStreamExt;
use kube::Client;
use serde_json::Value;

use super::id::{custom_node_id, split_api_version, CustomId};
use crate::discovery::{CustomKind, ResourceRef};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::NodeId;
use crate::manifest::{self, RawManifest};
use crate::session::scope::NamespaceScope;
use crate::session::{delete_one, ensure_resource_version, kube_err, set_current_identity, with_strict_validation, ObjectDetails};

/// A watch of one kind in one namespace (or cluster-wide), objects as JSON.
pub type WatchStream = BoxStream<'static, Result<Event<Value>, watcher::Error>>;

/// Where custom objects come from: the cluster, or a scripted fake in tests.
pub trait Source: Send + Sync + 'static {
    /// Every object of `r` in `namespace` (`None`: cluster-wide).
    fn list(&self, r: &ResourceRef, namespace: Option<&str>) -> BoxFuture<'static, AppResult<Vec<Value>>>;
    /// A watcher of `r` in `namespace` (`None`: cluster-wide), with the watcher's own backoff.
    fn watch(&self, r: &ResourceRef, namespace: Option<&str>) -> WatchStream;
}

pub fn api_resource(r: &ResourceRef) -> ApiResource {
    ApiResource {
        group: r.group.clone(),
        version: r.version.clone(),
        api_version: r.api_version(),
        kind: r.kind.clone(),
        plural: r.plural.clone(),
    }
}

pub fn api(client: &Client, r: &ResourceRef, namespace: Option<&str>) -> Api<DynamicObject> {
    let ar = api_resource(r);
    match namespace {
        Some(ns) if r.namespaced => Api::namespaced_with(client.clone(), ns, &ar),
        _ => Api::all_with(client.clone(), &ar),
    }
}

pub(crate) fn to_value(obj: &DynamicObject) -> AppResult<Value> {
    serde_json::to_value(obj).map_err(|e| AppError::internal(e.to_string()))
}

/// The cluster, through a cloned client.
pub struct KubeSource {
    client: Client,
}

impl KubeSource {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

impl Source for KubeSource {
    fn list(&self, r: &ResourceRef, namespace: Option<&str>) -> BoxFuture<'static, AppResult<Vec<Value>>> {
        let api = api(&self.client, r, namespace);
        async move {
            let list = api.list(&ListParams::default()).await.map_err(|e| AppError::from(&e))?;
            list.items.iter().map(to_value).collect()
        }
        .boxed()
    }

    fn watch(&self, r: &ResourceRef, namespace: Option<&str>) -> WatchStream {
        watcher(api(&self.client, r, namespace), watcher::Config::default())
            .default_backoff()
            .filter_map(|item| {
                // A `DynamicObject` always serialises; should one not, it is skipped.
                let item = match item {
                    Ok(ev) => to_value_event(ev).map(Ok),
                    Err(e) => Some(Err(e)),
                };
                futures::future::ready(item)
            })
            .boxed()
    }
}

fn to_value_event(ev: Event<DynamicObject>) -> Option<Event<Value>> {
    Some(match ev {
        Event::Init => Event::Init,
        Event::InitDone => Event::InitDone,
        Event::InitApply(o) => Event::InitApply(to_value(&o).ok()?),
        Event::Apply(o) => Event::Apply(to_value(&o).ok()?),
        Event::Delete(o) => Event::Delete(to_value(&o).ok()?),
    })
}

/// The streams one custom table reads in `scope`, by the rules of the built-in watches: one
/// per selected namespace for a namespaced kind, else a single cluster-wide one (`None`).
pub fn targets(r: &ResourceRef, scope: &NamespaceScope) -> Vec<Option<String>> {
    match scope {
        NamespaceScope::Set(set) if r.namespaced => set.iter().cloned().map(Some).collect(),
        _ => vec![None],
    }
}

/// The objects of a listing and the streams that answered it, which are the ones to watch.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub objects: Vec<Value>,
    pub targets: Vec<Option<String>>,
}

pub fn no_access(r: &ResourceRef) -> AppError {
    AppError::new(ErrorKind::Forbidden, format!("No access to {} (RBAC)", r.kind))
}

/// List `targets` concurrently. Forbidden targets are left out of the result; any other
/// error fails the listing.
async fn list_targets(source: &dyn Source, r: &ResourceRef, targets: Vec<Option<String>>) -> AppResult<Listed> {
    let answers = join_all(targets.iter().map(|t| source.list(r, t.as_deref()))).await;
    let mut listed = Listed {
        objects: Vec::new(),
        targets: Vec::new(),
    };
    for (target, answer) in targets.into_iter().zip(answers) {
        match answer {
            Ok(objects) => {
                listed.objects.extend(objects);
                listed.targets.push(target);
            }
            Err(e) if e.kind == ErrorKind::Forbidden => {
                tracing::warn!(kind = %r.kind, namespace = ?target, "custom resource list forbidden");
            }
            Err(e) => return Err(e),
        }
    }
    Ok(listed)
}

/// Every object of the kind in `scope`. Namespaces the user may not list are skipped. A
/// forbidden cluster-wide list (all namespaces) falls back to `fallback`, the namespaces
/// `connect` listed, as the built-in watches do. Nothing listable is [`no_access`].
pub async fn list(source: &dyn Source, r: &ResourceRef, scope: &NamespaceScope, fallback: &[String]) -> AppResult<Listed> {
    let listed = list_targets(source, r, targets(r, scope)).await?;
    if !listed.targets.is_empty() {
        return Ok(listed);
    }
    if *scope == NamespaceScope::All && r.namespaced && !fallback.is_empty() {
        let listed = list_targets(source, r, fallback.iter().cloned().map(Some).collect()).await?;
        if !listed.targets.is_empty() {
            return Ok(listed);
        }
    }
    Err(no_access(r))
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Invalid, message)
}

/// The namespace a request for `r` goes to: `namespace` for a namespaced kind (required), none
/// for a cluster-scoped one (a CR owner id carries its child's namespace, which is ignored).
pub fn target_namespace<'a>(r: &ResourceRef, namespace: Option<&'a str>) -> AppResult<Option<&'a str>> {
    if !r.namespaced {
        return Ok(None);
    }
    namespace
        .map(Some)
        .ok_or_else(|| invalid(format!("{} is namespaced; the id has no namespace", r.kind)))
}

/// An edit must describe the object `id` names: same apiVersion, kind, name and namespace.
pub fn ensure_matches(m: &RawManifest, id: &CustomId) -> AppResult<()> {
    let api_version = m.api_version.as_deref().ok_or_else(|| invalid("`apiVersion` is missing"))?;
    if api_version != id.api_version() {
        return Err(invalid(format!(
            "manifest apiVersion {api_version} does not match {} of the edited object",
            id.api_version()
        )));
    }
    if m.kind != id.kind {
        return Err(invalid(format!(
            "manifest kind {} does not match {} of the edited object",
            m.kind, id.kind
        )));
    }
    if m.name != id.name {
        return Err(invalid(format!(
            "manifest name {} does not match {}; renaming is not supported",
            m.name, id.name
        )));
    }
    if m.namespace.is_some() && m.namespace != id.namespace {
        return Err(invalid(
            "manifest namespace does not match the edited object; moving is not supported",
        ));
    }
    Ok(())
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |cur, k| cur.get(*k))?.as_str()
}

fn summary(v: &Value) -> Vec<(String, String)> {
    let mut rows = Vec::new();
    let mut push = |k: &str, val: String| rows.push((k.to_string(), val));
    push("Name", str_at(v, &["metadata", "name"]).unwrap_or_default().into());
    if let Some(ns) = str_at(v, &["metadata", "namespace"]) {
        push("Namespace", ns.into());
    }
    push(
        "Kind",
        format!(
            "{} ({})",
            str_at(v, &["kind"]).unwrap_or_default(),
            str_at(v, &["apiVersion"]).unwrap_or_default()
        ),
    );
    if let Some(created) = str_at(v, &["metadata", "creationTimestamp"]) {
        push("Created", created.into());
    }
    if let Some(labels) = v["metadata"]["labels"].as_object().filter(|l| !l.is_empty()) {
        push(
            "Labels",
            labels
                .iter()
                .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default()))
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    if let Some(owners) = v["metadata"]["ownerReferences"].as_array().filter(|o| !o.is_empty()) {
        push(
            "Owners",
            owners
                .iter()
                .map(|o| {
                    format!(
                        "{}/{}",
                        o["kind"].as_str().unwrap_or_default(),
                        o["name"].as_str().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    for c in v["status"]["conditions"].as_array().into_iter().flatten() {
        let status = c["status"].as_str().unwrap_or_default();
        let text = match c["reason"].as_str().filter(|r| !r.is_empty()) {
            Some(reason) => format!("{status} ({reason})"),
            None => status.to_string(),
        };
        push(c["type"].as_str().unwrap_or("Condition"), text);
    }
    rows
}

/// YAML (without managedFields) and Overview rows of a custom object; `related` is the
/// caller's to fill from the graph.
pub fn details_of(mut value: Value) -> AppResult<ObjectDetails> {
    if let Some(meta) = value.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
    }
    let yaml = serde_yaml_ng::to_string(&value).map_err(|e| AppError::internal(e.to_string()))?;
    Ok(ObjectDetails {
        yaml,
        summary: summary(&value),
        related: Vec::new(),
    })
}

pub async fn get(client: &Client, kind: &CustomKind, id: &CustomId) -> AppResult<ObjectDetails> {
    let ns = target_namespace(&kind.resource, id.namespace.as_deref())?;
    let obj = api(client, &kind.resource, ns).get(&id.name).await.map_err(kube_err)?;
    details_of(to_value(&obj)?)
}

fn put_namespace(body: &mut Value, namespace: Option<&str>) {
    if let (Some(ns), Some(meta)) = (namespace, body.get_mut("metadata").and_then(Value::as_object_mut)) {
        meta.insert("namespace".into(), Value::String(ns.to_owned()));
    }
}

/// Replace the object `id` names with `yaml`, with the same conflict rules as built-in kinds:
/// without `force` the manifest's resourceVersion must be current; with it the server's is used.
pub async fn update(client: &Client, kind: &CustomKind, id: &CustomId, yaml: &str, force: bool) -> AppResult<ObjectDetails> {
    let m = manifest::parse_raw(yaml)?;
    ensure_matches(&m, id)?;
    let ns = target_namespace(&kind.resource, id.namespace.as_deref())?;
    let mut body = m.body;
    put_namespace(&mut body, ns);
    if force {
        let current = api(client, &kind.resource, ns).get(&id.name).await.map_err(kube_err)?;
        let rv = current
            .metadata
            .resource_version
            .ok_or_else(|| AppError::internal(format!("{} has no resourceVersion", id.node_id())))?;
        set_current_identity(&mut body, &rv, current.metadata.uid.as_deref());
    } else {
        ensure_resource_version(&body)?;
    }
    let bytes = serde_json::to_vec(&body).map_err(|e| AppError::internal(e.to_string()))?;
    let ar = api_resource(&kind.resource);
    let req = Request::new(DynamicObject::url_path(&ar, ns))
        .replace(&id.name, &PostParams::default(), bytes)
        .map_err(|e| AppError::internal(e.to_string()))?;
    let saved: Value = client.request(with_strict_validation(req)?).await.map_err(kube_err)?;
    details_of(saved)
}

/// Create `m` (already resolved to `kind`); its own namespace wins over `fallback_namespace`.
pub async fn create(client: &Client, kind: &CustomKind, m: RawManifest, fallback_namespace: &str) -> AppResult<NodeId> {
    let r = &kind.resource;
    let ns: Option<String> = if r.namespaced {
        Some(
            m.namespace
                .clone()
                .or_else(|| (!fallback_namespace.is_empty()).then(|| fallback_namespace.to_owned()))
                .ok_or_else(|| invalid("metadata.namespace is missing and no namespace is selected"))?,
        )
    } else {
        None
    };
    let mut body = m.body;
    put_namespace(&mut body, ns.as_deref());
    let bytes = serde_json::to_vec(&body).map_err(|e| AppError::internal(e.to_string()))?;
    let req = Request::new(DynamicObject::url_path(&api_resource(r), ns.as_deref()))
        .create(&PostParams::default(), bytes)
        .map_err(|e| AppError::internal(e.to_string()))?;
    let _created: Value = client.request(with_strict_validation(req)?).await.map_err(kube_err)?;
    Ok(custom_node_id(&r.group, &r.version, &r.kind, ns.as_deref(), &m.name))
}

pub async fn delete(client: &Client, kind: &CustomKind, id: &CustomId) -> AppResult<()> {
    let ns = target_namespace(&kind.resource, id.namespace.as_deref())?;
    delete_one(&api(client, &kind.resource, ns), &id.name).await
}

/// (`group`, `version`) of a manifest's apiVersion, required for a custom kind.
pub fn manifest_group_version(m: &RawManifest) -> AppResult<(&str, &str)> {
    m.api_version
        .as_deref()
        .map(split_api_version)
        .ok_or_else(|| invalid("`apiVersion` is missing"))
}

#[cfg(test)]
pub(crate) mod fake {
    //! A scripted `Source`: lists answer from a map (optionally held until a gate opens), and
    //! every watch is a channel the test pushes events into.

    use std::collections::HashMap;
    use std::sync::Mutex;

    use futures::channel::mpsc as fmpsc;
    use futures::{FutureExt, StreamExt};
    use kube::runtime::watcher::{self, Event};
    use serde_json::Value;
    use tokio::sync::{mpsc, oneshot};

    use super::{Source, WatchStream};
    use crate::discovery::ResourceRef;
    use crate::error::{AppError, ErrorKind};

    pub type WatchTx = fmpsc::UnboundedSender<Result<Event<Value>, watcher::Error>>;

    #[derive(Default)]
    struct State {
        /// (kind, namespace) -> answer; missing means an empty list.
        answers: HashMap<(String, Option<String>), Result<Vec<Value>, AppError>>,
        /// kind -> held lists; each list call of that kind waits for the next gate.
        gates: HashMap<String, Vec<oneshot::Receiver<()>>>,
        watches: Vec<(String, Option<String>, WatchTx)>,
        lists_started: Option<mpsc::UnboundedSender<String>>,
    }

    #[derive(Default)]
    pub struct FakeSource {
        state: Mutex<State>,
    }

    impl FakeSource {
        pub fn answer(&self, kind: &str, ns: Option<&str>, objects: Vec<Value>) {
            let key = (kind.to_string(), ns.map(str::to_owned));
            self.state.lock().unwrap().answers.insert(key, Ok(objects));
        }

        pub fn fail(&self, kind: &str, ns: Option<&str>, kind_of_error: ErrorKind) {
            let key = (kind.to_string(), ns.map(str::to_owned));
            let err = AppError::new(kind_of_error, "scripted failure");
            self.state.lock().unwrap().answers.insert(key, Err(err));
        }

        /// Hold the next list of `kind` until the returned sender fires (or is dropped).
        pub fn hold(&self, kind: &str) -> oneshot::Sender<()> {
            let (tx, rx) = oneshot::channel();
            self.state.lock().unwrap().gates.entry(kind.to_string()).or_default().push(rx);
            tx
        }

        /// Receives the kind of every list call as it starts.
        pub fn lists_started(&self) -> mpsc::UnboundedReceiver<String> {
            let (tx, rx) = mpsc::unbounded_channel();
            self.state.lock().unwrap().lists_started = Some(tx);
            rx
        }

        /// The watches opened so far: (kind, namespace, sender).
        pub fn watches(&self) -> Vec<(String, Option<String>, WatchTx)> {
            self.state.lock().unwrap().watches.clone()
        }

        pub fn watches_of(&self, kind: &str) -> Vec<WatchTx> {
            self.watches().into_iter().filter(|w| w.0 == kind).map(|w| w.2).collect()
        }
    }

    impl Source for FakeSource {
        fn list(&self, r: &ResourceRef, namespace: Option<&str>) -> futures::future::BoxFuture<'static, Result<Vec<Value>, AppError>> {
            let mut state = self.state.lock().unwrap();
            let key = (r.kind.clone(), namespace.map(str::to_owned));
            let answer = state.answers.get(&key).cloned().unwrap_or_else(|| Ok(vec![]));
            let gate = state.gates.get_mut(&r.kind).and_then(|g| (!g.is_empty()).then(|| g.remove(0)));
            if let Some(tx) = &state.lists_started {
                let _ = tx.send(r.kind.clone());
            }
            async move {
                if let Some(gate) = gate {
                    let _ = gate.await;
                }
                answer
            }
            .boxed()
        }

        fn watch(&self, r: &ResourceRef, namespace: Option<&str>) -> WatchStream {
            let (tx, rx) = fmpsc::unbounded();
            self.state
                .lock()
                .unwrap()
                .watches
                .push((r.kind.clone(), namespace.map(str::to_owned), tx));
            rx.boxed()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeSource;
    use super::*;
    use crate::error::ErrorKind;
    use serde_json::json;

    fn cert_ref(namespaced: bool) -> ResourceRef {
        ResourceRef {
            group: "cert-manager.io".into(),
            version: "v1".into(),
            kind: "Certificate".into(),
            plural: "certificates".into(),
            namespaced,
        }
    }

    fn obj(ns: &str, name: &str) -> Value {
        json!({ "metadata": { "namespace": ns, "name": name } })
    }

    fn set(names: &[&str]) -> NamespaceScope {
        NamespaceScope::from_arg(Some(names.iter().map(|n| n.to_string()).collect())).unwrap()
    }

    #[test]
    fn targets_follow_the_scope_rules_of_the_built_in_watches() {
        let r = cert_ref(true);
        assert_eq!(targets(&r, &set(&["b", "a"])), vec![Some("a".to_string()), Some("b".to_string())]);
        assert_eq!(targets(&r, &NamespaceScope::All), vec![None]);
        assert_eq!(
            targets(&cert_ref(false), &set(&["a", "b"])),
            vec![None],
            "cluster-scoped: one stream"
        );
    }

    #[test]
    fn api_resources_carry_the_api_version() {
        let ar = api_resource(&cert_ref(true));
        assert_eq!(ar.api_version, "cert-manager.io/v1");
        assert_eq!(ar.plural, "certificates");
    }

    #[tokio::test]
    async fn lists_every_selected_namespace() {
        let src = FakeSource::default();
        src.answer("Certificate", Some("a"), vec![obj("a", "x")]);
        src.answer("Certificate", Some("b"), vec![obj("b", "y"), obj("b", "z")]);
        let listed = list(&src, &cert_ref(true), &set(&["a", "b"]), &[]).await.unwrap();
        assert_eq!(listed.objects.len(), 3);
        assert_eq!(listed.targets, vec![Some("a".to_string()), Some("b".to_string())]);
    }

    #[tokio::test]
    async fn forbidden_namespaces_are_skipped_and_not_watched() {
        let src = FakeSource::default();
        src.answer("Certificate", Some("a"), vec![obj("a", "x")]);
        src.fail("Certificate", Some("b"), ErrorKind::Forbidden);
        let listed = list(&src, &cert_ref(true), &set(&["a", "b"]), &[]).await.unwrap();
        assert_eq!(listed.objects, vec![obj("a", "x")]);
        assert_eq!(listed.targets, vec![Some("a".to_string())]);
    }

    #[tokio::test]
    async fn no_access_anywhere_is_a_clear_rbac_error() {
        let src = FakeSource::default();
        src.fail("Certificate", Some("a"), ErrorKind::Forbidden);
        src.fail("Certificate", Some("b"), ErrorKind::Forbidden);
        let err = list(&src, &cert_ref(true), &set(&["a", "b"]), &[]).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Forbidden);
        assert_eq!(err.message, "No access to Certificate (RBAC)");
    }

    #[tokio::test]
    async fn a_forbidden_cluster_wide_list_falls_back_to_the_known_namespaces() {
        let src = FakeSource::default();
        src.fail("Certificate", None, ErrorKind::Forbidden);
        src.answer("Certificate", Some("a"), vec![obj("a", "x")]);
        src.fail("Certificate", Some("b"), ErrorKind::Forbidden);
        let fallback = ["a".to_string(), "b".to_string()];
        let listed = list(&src, &cert_ref(true), &NamespaceScope::All, &fallback).await.unwrap();
        assert_eq!(listed.objects, vec![obj("a", "x")]);
        assert_eq!(listed.targets, vec![Some("a".to_string())]);

        // Cluster-scoped kinds have nothing to fall back to.
        src.fail("Certificate", None, ErrorKind::Forbidden);
        let err = list(&src, &cert_ref(false), &NamespaceScope::All, &fallback).await.unwrap_err();
        assert_eq!(err.message, "No access to Certificate (RBAC)");
    }

    #[tokio::test]
    async fn other_errors_fail_the_list() {
        let src = FakeSource::default();
        src.answer("Certificate", Some("a"), vec![obj("a", "x")]);
        src.fail("Certificate", Some("b"), ErrorKind::Network);
        let err = list(&src, &cert_ref(true), &set(&["a", "b"]), &[]).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Network);
    }

    use crate::custom::id::CustomId;
    use crate::manifest::parse_raw;

    fn id() -> CustomId {
        CustomId::parse("Custom/cert-manager.io/v1/Certificate/shop/web-tls").unwrap()
    }

    const YAML: &str = "apiVersion: cert-manager.io/v1\nkind: Certificate\nmetadata:\n  name: web-tls\n  namespace: shop\nspec: {}\n";

    #[test]
    fn a_matching_manifest_passes() {
        ensure_matches(&parse_raw(YAML).unwrap(), &id()).unwrap();
        // The namespace may be left out; the id supplies it.
        ensure_matches(&parse_raw(&YAML.replace("  namespace: shop\n", "")).unwrap(), &id()).unwrap();
    }

    #[test]
    fn edits_cannot_move_rename_or_retype_the_object() {
        for (from, to) in [
            ("name: web-tls", "name: other"),
            ("namespace: shop", "namespace: elsewhere"),
            ("kind: Certificate", "kind: Issuer"),
            ("cert-manager.io/v1", "cert-manager.io/v1beta1"),
        ] {
            let err = ensure_matches(&parse_raw(&YAML.replace(from, to)).unwrap(), &id()).unwrap_err();
            assert_eq!(err.kind, crate::error::ErrorKind::Invalid, "{to}");
        }
        let no_api_version = parse_raw(&YAML.replace("apiVersion: cert-manager.io/v1\n", "")).unwrap();
        assert!(ensure_matches(&no_api_version, &id()).is_err());
    }

    #[test]
    fn details_show_yaml_without_managed_fields_and_a_summary() {
        let d = details_of(json!({
            "apiVersion": "cert-manager.io/v1", "kind": "Certificate",
            "metadata": {
                "name": "web-tls", "namespace": "shop", "creationTimestamp": "2026-10-03T12:00:00Z",
                "labels": { "app": "web" },
                "ownerReferences": [{ "apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "name": "web", "uid": "u" }],
                "managedFields": [{ "manager": "kubectl" }]
            },
            "status": { "conditions": [{ "type": "Ready", "status": "True", "reason": "Ready" }] }
        }))
        .unwrap();
        assert!(d.yaml.contains("kind: Certificate"));
        assert!(!d.yaml.contains("managedFields"));
        let rows: Vec<(&str, &str)> = d.summary.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(
            rows,
            vec![
                ("Name", "web-tls"),
                ("Namespace", "shop"),
                ("Kind", "Certificate (cert-manager.io/v1)"),
                ("Created", "2026-10-03T12:00:00Z"),
                ("Labels", "app=web"),
                ("Owners", "Ingress/web"),
                ("Ready", "True (Ready)"),
            ]
        );
        assert!(d.related.is_empty());
    }

    #[test]
    fn target_namespace_follows_the_scope_of_the_kind() {
        let namespaced = cert_ref(true);
        let cluster = cert_ref(false);
        assert_eq!(target_namespace(&namespaced, Some("a")).unwrap(), Some("a"));
        assert!(target_namespace(&namespaced, None).is_err());
        assert_eq!(
            target_namespace(&cluster, Some("a")).unwrap(),
            None,
            "a CR owner id carries its child's namespace"
        );
    }
}
