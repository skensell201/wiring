//! Dynamic-API access to custom resources. Requests go through a [`Source`] (the real one
//! wraps a cloned `Client`), so callers never hold the session lock across them and tests
//! script the cluster.

use futures::future::{join_all, BoxFuture};
use futures::stream::BoxStream;
use futures::{FutureExt, StreamExt};
use kube::api::{Api, ListParams};
use kube::core::{ApiResource, DynamicObject};
use kube::runtime::watcher::{self, watcher, Event};
use kube::runtime::WatchStreamExt;
use kube::Client;
use serde_json::Value;

use crate::discovery::ResourceRef;
use crate::error::{AppError, AppResult, ErrorKind};
use crate::session::scope::NamespaceScope;

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
}
