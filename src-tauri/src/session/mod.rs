//! One live connection to a cluster: watchers, store, graph, events.

pub mod emitter;
pub mod reducer;
pub mod rollout;
pub mod shared;
pub mod watch;
pub mod write;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use futures::StreamExt;
use k8s_openapi::api::core::v1::{Event as CoreEvent, Namespace};
use kube::api::{Api, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::runtime::watcher::{self, watcher, Event};
use kube::runtime::WatchStreamExt;
use kube::{Client, Config};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::rows::Table;
use crate::graph::{status::summary, Graph, NodeId};
use crate::logs::session::{spawn_log_session, LogRequest, LogSession};
use crate::logs::LogSink;
use crate::store::{Kind, Store};
use emitter::{ClosableEmitter, Emitter, K8sEvent, ObjectEvents, OutEvent};
use reducer::{spawn_reducer, ReducerConfig, ReducerMsg};
use shared::Shared;
use watch::spawn_all;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub context: String,
    pub server_version: String,
    pub namespaces: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetails {
    pub yaml: String,
    pub summary: Vec<(String, String)>,
    pub related: Vec<NodeId>,
}

fn find_context<'a>(kubeconfig: &'a Kubeconfig, context: &str) -> Option<&'a kube::config::Context> {
    kubeconfig
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
}

/// The exec-plugin binary configured for `context`'s user, if any.
fn exec_plugin_command(kubeconfig: &Kubeconfig, context: &str) -> Option<String> {
    let user = find_context(kubeconfig, context).and_then(|c| c.user.as_deref())?;
    kubeconfig
        .auth_infos
        .iter()
        .find(|a| a.name == user)
        .and_then(|a| a.auth_info.as_ref())
        .and_then(|a| a.exec.as_ref())
        .and_then(|e| e.command.clone())
}

/// Users without cluster-wide `list namespaces` (common with namespace-scoped RBAC) can
/// still browse the namespace their context names, so a 403 here must not fail `connect`.
fn namespaces_or_fallback(listed: Result<Vec<String>, kube::Error>, context_namespace: Option<&str>) -> AppResult<Vec<String>> {
    match listed {
        Ok(namespaces) => Ok(namespaces),
        Err(e) => {
            let err = AppError::from(&e);
            if err.kind != ErrorKind::Forbidden {
                return Err(err);
            }
            tracing::warn!(error = %err.message, "cannot list namespaces; falling back to the context namespace");
            Ok(context_namespace.map(str::to_owned).into_iter().collect())
        }
    }
}

/// Map a client error, naming the exec plugin on `Auth` failures so the user learns which
/// binary is missing or broken (spec §8) — kube's own message only carries the OS error.
fn app_error_from_client(e: &kube::Error, exec_command: Option<&str>) -> AppError {
    let mut err = AppError::from(e);
    if err.kind == ErrorKind::Auth {
        if let Some(cmd) = exec_command {
            err.message.push_str(&format!(" (exec plugin: {cmd})"));
        }
    }
    err
}

pub struct Session {
    client: Client,
    shared: Shared,
    /// Session-lifetime emitter: connection state, and the parent of `ns_emitter`.
    emitter: Arc<dyn Emitter>,
    /// Emitter for the current namespace's reducer and events watcher; closed on every
    /// namespace switch so aborted tasks cannot leak stale events.
    ns_emitter: ClosableEmitter,
    reducer_tx: Option<mpsc::Sender<ReducerMsg>>,
    tasks: Vec<JoinHandle<()>>,
    events_task: Option<JoinHandle<()>>,
    /// Live log sessions by id; dropping one aborts its streams.
    logs: HashMap<u32, LogSession>,
    next_log_id: u32,
}

impl Session {
    pub async fn connect(kubeconfig: Kubeconfig, context: &str, emitter: Arc<dyn Emitter>) -> AppResult<(Session, ConnectInfo)> {
        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            cluster: None,
            user: None,
        };
        let exec_command = exec_plugin_command(&kubeconfig, context);
        let context_namespace = find_context(&kubeconfig, context).and_then(|c| c.namespace.clone());
        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| AppError::from(&e))?;
        // `Client::try_from` runs the exec plugin synchronously (it can block for seconds),
        // so keep it off the async runtime threads.
        let client = tokio::task::spawn_blocking(move || Client::try_from(config))
            .await
            .map_err(|e| AppError::internal(format!("client setup task failed: {e}")))?
            .map_err(|e| app_error_from_client(&e, exec_command.as_deref()))?;

        let version = client
            .apiserver_version()
            .await
            .map_err(|e| app_error_from_client(&e, exec_command.as_deref()))?;
        let listed = Api::<Namespace>::all(client.clone())
            .list(&ListParams::default())
            .await
            .map(|list| list.items.into_iter().filter_map(|n| n.metadata.name).collect::<Vec<_>>());
        let namespaces = namespaces_or_fallback(listed, context_namespace.as_deref())?;

        let info = ConnectInfo {
            context: context.to_string(),
            server_version: version.git_version,
            namespaces,
        };
        Ok((Session::new(client, emitter), info))
    }

    fn new(client: Client, emitter: Arc<dyn Emitter>) -> Session {
        Session {
            client,
            shared: Shared::default(),
            ns_emitter: ClosableEmitter::new(emitter.clone()),
            emitter,
            reducer_tx: None,
            tasks: vec![],
            events_task: None,
            logs: HashMap::new(),
            next_log_id: 1,
        }
    }

    /// Tell the frontend this session is live. Deliberately not part of `connect`: the caller
    /// emits it only after any previous session has been shut down (which emits
    /// `Disconnected`) and the new one is installed, so `connected` is the last state seen.
    pub fn announce_connected(&self) {
        self.emitter.emit(OutEvent::ConnectionState(emitter::ConnectionState::Connected));
    }

    pub fn denied_kinds(&self) -> Vec<Kind> {
        let mut v: Vec<Kind> = self.shared.denied_kinds().iter().copied().collect();
        v.sort();
        v
    }

    /// Tear down any previous watchers and start watching `namespace`.
    pub async fn select_namespace(&mut self, namespace: &str, expanded_groups: HashSet<NodeId>) -> AppResult<()> {
        self.stop_watchers();
        self.shared = Shared::default();
        *self.shared.expanded_groups() = expanded_groups;
        self.ns_emitter = ClosableEmitter::new(self.emitter.clone());

        let (reducer_tx, reducer_task) = spawn_reducer(ReducerConfig::default(), self.shared.clone(), Arc::new(self.ns_emitter.clone()));
        let (store_tx, mut store_rx) = mpsc::channel(4096);
        // Bridge StoreEvent -> ReducerMsg so watchers do not know about the reducer.
        let bridge_tx = reducer_tx.clone();
        let bridge = tokio::spawn(async move {
            while let Some(ev) = store_rx.recv().await {
                if bridge_tx.send(ReducerMsg::Store(ev)).await.is_err() {
                    break;
                }
            }
        });
        self.tasks = spawn_all(&self.client, namespace, &store_tx);
        self.tasks.push(bridge);
        self.tasks.push(reducer_task);
        self.reducer_tx = Some(reducer_tx);
        Ok(())
    }

    pub async fn set_expanded_groups(&mut self, expanded_groups: HashSet<NodeId>) -> AppResult<()> {
        *self.shared.expanded_groups() = expanded_groups;
        self.request_rebuild().await
    }

    /// Ask the reducer to rebuild the graph from the store now (a no-op before any namespace
    /// is selected).
    pub(crate) async fn request_rebuild(&self) -> AppResult<()> {
        if let Some(tx) = &self.reducer_tx {
            tx.send(ReducerMsg::Rebuild)
                .await
                .map_err(|_| AppError::internal("reducer stopped"))?;
        }
        Ok(())
    }

    pub fn get_object(&self, node_id: &str) -> AppResult<ObjectDetails> {
        // Lock sequentially (never store + graph at once) to keep the same
        // ordering discipline as `Shared::rebuild` and rule out deadlocks.
        let graph = self.shared.graph().clone();
        let store = self.shared.store();
        object_details(&store, &graph, node_id)
    }

    pub fn list_rows(&self, kind: Kind) -> Table {
        let store = self.shared.store();
        crate::graph::rows::table(&store, kind, k8s_openapi::jiff::Timestamp::now())
    }

    /// Watch core/v1 Events for one object (or stop when `None`).
    pub async fn watch_events(&mut self, node_id: Option<&str>) -> AppResult<()> {
        if let Some(t) = self.events_task.take() {
            t.abort();
        }
        let Some(node_id) = node_id else { return Ok(()) };
        let (kind, ns, name) = parse_node_id(node_id)?;
        if kind == Kind::PodGroup {
            return Ok(());
        }
        let uid = {
            let store = self.shared.store();
            store
                .find(kind, ns.as_deref(), &name)
                .and_then(|o| o.uid().map(str::to_owned))
                .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in store")))?
        };
        // Cluster-scoped objects (e.g. PersistentVolume) have no namespace of their own; the
        // `involvedObject.uid` field selector below already narrows the watch to that one
        // object, so falling back to the browsed namespace here would just miss their events.
        let api: Api<CoreEvent> = match ns.as_deref() {
            Some(ns) => Api::namespaced(self.client.clone(), ns),
            None => Api::all(self.client.clone()),
        };
        let emitter: Arc<dyn Emitter> = Arc::new(self.ns_emitter.clone());
        let node_id = node_id.to_string();
        self.events_task = Some(tokio::spawn(async move {
            let cfg = watcher::Config::default().fields(&format!("involvedObject.uid={uid}"));
            let stream = watcher(api, cfg).default_backoff().boxed();
            forward_object_events(node_id, stream, emitter).await;
        }));
        Ok(())
    }

    /// Start streaming logs for `req` into `sink`; returns the session id for `stop_logs`.
    pub fn start_logs(&mut self, req: LogRequest, sink: Arc<dyn LogSink>) -> AppResult<u32> {
        let id = self.next_log_id;
        self.next_log_id = self.next_log_id.wrapping_add(1);
        let session = spawn_log_session(id, self.client.clone(), self.shared.clone(), req, sink)?;
        self.logs.insert(id, session);
        Ok(id)
    }

    /// Stop a log session: nothing reaches its channel once this returns. Unknown ids are a
    /// no-op.
    pub fn stop_logs(&mut self, id: u32) {
        if let Some(session) = self.logs.remove(&id) {
            session.close(); // then drop aborts the streams
        }
    }

    fn stop_watchers(&mut self) {
        // A namespace switch, disconnect or drop must end every log stream of the session;
        // close each sink first so no batch slips out before the aborts land.
        for session in self.logs.values() {
            session.close();
        }
        self.logs.clear();
        // Close before aborting: an abort only lands at the task's next `.await`, and a
        // reducer mid-rebuild would otherwise still emit one snapshot of the old namespace.
        self.ns_emitter.close();
        for t in self.tasks.drain(..) {
            t.abort();
        }
        if let Some(t) = self.events_task.take() {
            t.abort();
        }
        self.reducer_tx = None;
    }

    pub fn shutdown(&mut self) {
        self.stop_watchers();
        self.emitter.emit(OutEvent::ConnectionState(emitter::ConnectionState::Disconnected));
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop_watchers();
    }
}

/// Mirror a core/v1 Event watch into `object_events` for one node.
///
/// Emits once per visible change — after the (re-)list completes and on every later
/// apply/delete — rather than per stream item, so startup produces one list instead of
/// N+2 and a re-list does not flash an empty tab. Cluster-free (generic over the stream)
/// so it is unit-tested without a real `Api`.
async fn forward_object_events<S>(node_id: NodeId, mut stream: S, emitter: Arc<dyn Emitter>)
where
    S: futures::Stream<Item = Result<Event<CoreEvent>, watcher::Error>> + Unpin,
{
    // Built up during a (re-)list; swapped into `events` on InitDone.
    let mut listing: BTreeMap<String, CoreEvent> = BTreeMap::new();
    let mut events: BTreeMap<String, CoreEvent> = BTreeMap::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(Event::Init) => {
                listing.clear();
                continue;
            }
            Ok(Event::InitApply(e)) => {
                listing.insert(e.metadata.name.clone().unwrap_or_default(), e);
                continue;
            }
            Ok(Event::InitDone) => events = std::mem::take(&mut listing),
            Ok(Event::Apply(e)) => {
                events.insert(e.metadata.name.clone().unwrap_or_default(), e);
            }
            Ok(Event::Delete(e)) => {
                events.remove(&e.metadata.name.clone().unwrap_or_default());
            }
            Err(e) => {
                tracing::warn!(error = %e, "events watcher error");
                continue;
            }
        }
        emitter.emit(OutEvent::ObjectEvents(ObjectEvents {
            node_id: node_id.clone(),
            events: events_to_list(&events),
        }));
    }
}

/// `"Kind/ns/name"`; cluster-scoped `"Kind//name"`; PodGroup `"PodGroup/ns/OwnerKind/ownerName"`.
pub fn parse_node_id(id: &str) -> AppResult<(Kind, Option<String>, String)> {
    let mut parts = id.splitn(3, '/');
    let (Some(kind), Some(ns), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(AppError::new(ErrorKind::NotFound, format!("malformed node id `{id}`")));
    };
    let kind = if kind == "PodGroup" {
        Kind::PodGroup
    } else {
        Kind::parse(kind).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("unknown kind in `{id}`")))?
    };
    let ns = if ns.is_empty() { None } else { Some(ns.to_string()) };
    Ok((kind, ns, name.to_string()))
}

pub fn object_details(store: &Store, graph: &Graph, node_id: &str) -> AppResult<ObjectDetails> {
    let (kind, ns, name) = parse_node_id(node_id)?;
    let related: Vec<NodeId> = {
        let mut r: Vec<NodeId> = graph
            .edges_touching(node_id)
            .map(|e| if e.source == node_id { e.target.clone() } else { e.source.clone() })
            .collect();
        r.sort();
        r.dedup();
        r
    };
    if kind == Kind::PodGroup {
        let node = graph
            .node(node_id)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in graph")))?;
        let info = node.group.clone().unwrap_or(crate::graph::GroupInfo {
            count: 0,
            ok: 0,
            warn: 0,
            err: 0,
        });
        let summary = vec![
            ("Owner".to_string(), name),
            ("Namespace".to_string(), ns.unwrap_or_default()),
            ("Pods".to_string(), info.count.to_string()),
            ("Ok".to_string(), info.ok.to_string()),
            ("Warning".to_string(), info.warn.to_string()),
            ("Error".to_string(), info.err.to_string()),
        ];
        return Ok(ObjectDetails {
            yaml: String::new(),
            summary,
            related,
        });
    }
    let obj = store
        .find(kind, ns.as_deref(), &name)
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in store")))?;
    details_of(obj, related)
}

/// The details of one object: its YAML and summary rows, with the given related nodes.
fn details_of(obj: &crate::store::Object, related: Vec<NodeId>) -> AppResult<ObjectDetails> {
    let yaml = serde_yaml_ng::to_string(&obj.to_json_value()).map_err(|e| AppError::internal(e.to_string()))?;
    Ok(ObjectDetails {
        yaml,
        summary: summary(obj),
        related,
    })
}

/// Details built from an object the server just returned, when the store cannot supply them.
pub(super) fn saved_details(obj: &crate::store::Object) -> AppResult<ObjectDetails> {
    details_of(obj, Vec::new())
}

pub fn events_to_list(events: &BTreeMap<String, CoreEvent>) -> Vec<K8sEvent> {
    let mut list: Vec<(Option<String>, K8sEvent)> = events
        .values()
        .map(|e| {
            // k8s-openapi 0.28 wraps `jiff::Timestamp`; its Display is RFC 3339 ("...Z").
            let last = e
                .last_timestamp
                .as_ref()
                .map(|t| t.0.to_string())
                .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()));
            let ev = K8sEvent {
                name: e.metadata.name.clone().unwrap_or_default(),
                type_: e.type_.clone().unwrap_or_else(|| "Normal".into()),
                reason: e.reason.clone().unwrap_or_default(),
                message: e.message.clone().unwrap_or_default(),
                count: e.count.unwrap_or(1),
                first_timestamp: e.first_timestamp.as_ref().map(|t| t.0.to_string()),
                last_timestamp: last.clone(),
            };
            (last, ev)
        })
        .collect();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    list.into_iter().map(|(_, e)| e).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Kind, Store};

    #[tokio::test]
    async fn announce_connected_emits_connected_state() {
        use crate::session::emitter::{ChannelEmitter, ConnectionState};
        let (emitter, mut rx) = ChannelEmitter::new();
        let client = Client::try_from(Config::new("https://127.0.0.1:1".parse().unwrap())).unwrap();
        let session = Session::new(client, Arc::new(emitter));
        assert!(rx.try_recv().is_err(), "constructing a session must not emit anything");
        session.announce_connected();
        assert_eq!(rx.try_recv().unwrap(), OutEvent::ConnectionState(ConnectionState::Connected));
    }

    #[tokio::test]
    async fn missing_exec_plugin_is_an_auth_error_naming_the_binary() {
        use crate::session::emitter::ChannelEmitter;
        use kube::config::{AuthInfo, Cluster, Context, ExecConfig, NamedAuthInfo, NamedCluster, NamedContext};
        let kubeconfig = Kubeconfig {
            clusters: vec![NamedCluster {
                name: "c".into(),
                cluster: Some(Cluster {
                    server: Some("https://127.0.0.1:1".into()),
                    ..Default::default()
                }),
                other: Default::default(),
            }],
            auth_infos: vec![NamedAuthInfo {
                name: "u".into(),
                auth_info: Some(AuthInfo {
                    exec: Some(ExecConfig {
                        command: Some("/nonexistent/wiring-auth-plugin".into()),
                        api_version: Some("client.authentication.k8s.io/v1".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                other: Default::default(),
            }],
            contexts: vec![NamedContext {
                name: "ctx".into(),
                context: Some(Context {
                    cluster: "c".into(),
                    user: Some("u".into()),
                    ..Default::default()
                }),
                other: Default::default(),
            }],
            ..Default::default()
        };
        let (emitter, _rx) = ChannelEmitter::new();
        let err = Session::connect(kubeconfig, "ctx", Arc::new(emitter))
            .await
            .err()
            .expect("connect must fail");
        assert_eq!(err.kind, ErrorKind::Auth, "{err:?}");
        assert!(err.message.contains("wiring-auth-plugin"), "{}", err.message);
    }

    #[test]
    fn forbidden_namespace_listing_falls_back_to_context_namespace() {
        let forbidden = || {
            kube::Error::Api(Box::new(kube::core::Status {
                code: 403,
                message: "namespaces is forbidden".into(),
                reason: "Forbidden".into(),
                ..Default::default()
            }))
        };
        assert_eq!(
            namespaces_or_fallback(Err(forbidden()), Some("team-a")).unwrap(),
            vec!["team-a".to_string()]
        );
        assert_eq!(namespaces_or_fallback(Err(forbidden()), None).unwrap(), Vec::<String>::new());
        assert_eq!(
            namespaces_or_fallback(Ok(vec!["a".into(), "b".into()]), Some("team-a")).unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
        let unauthorized = kube::Error::Api(Box::new(kube::core::Status {
            code: 401,
            message: "no".into(),
            reason: "Unauthorized".into(),
            ..Default::default()
        }));
        assert_eq!(
            namespaces_or_fallback(Err(unauthorized), Some("team-a")).unwrap_err().kind,
            ErrorKind::Auth
        );
    }

    #[tokio::test]
    async fn object_events_are_emitted_once_per_change_not_per_stream_item() {
        use crate::session::emitter::ChannelEmitter;
        use k8s_openapi::api::core::v1::Event as CoreEvent;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
        let ev = |name: &str| CoreEvent {
            metadata: ObjectMeta {
                name: Some(name.into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let items: Vec<Result<Event<CoreEvent>, watcher::Error>> = vec![
            Ok(Event::Init),
            Ok(Event::InitApply(ev("a"))),
            Ok(Event::InitApply(ev("b"))),
            Ok(Event::InitDone),
            Err(watcher::Error::NoResourceVersion),
            Ok(Event::Apply(ev("c"))),
            Ok(Event::Delete(ev("a"))),
            // A re-list must not flash an empty list: nothing until InitDone.
            Ok(Event::Init),
            Ok(Event::InitApply(ev("b"))),
            Ok(Event::InitDone),
        ];
        let (emitter, mut rx) = ChannelEmitter::new();
        forward_object_events("Pod/n/p".into(), futures::stream::iter(items), Arc::new(emitter)).await;
        let mut lists = Vec::new();
        while let Ok(OutEvent::ObjectEvents(e)) = rx.try_recv() {
            assert_eq!(e.node_id, "Pod/n/p");
            lists.push(e.events.into_iter().map(|e| e.name).collect::<Vec<_>>());
        }
        assert_eq!(lists, vec![vec!["a", "b"], vec!["a", "b", "c"], vec!["b", "c"], vec!["b"]]);
    }

    #[test]
    fn parses_node_ids() {
        assert_eq!(
            parse_node_id("Pod/payments/web-1").unwrap(),
            (Kind::Pod, Some("payments".to_string()), "web-1".to_string())
        );
        assert_eq!(
            parse_node_id("PersistentVolume//pv-1").unwrap(),
            (Kind::PersistentVolume, None, "pv-1".to_string())
        );
        assert_eq!(
            parse_node_id("PodGroup/g/Deployment/api").unwrap(),
            (Kind::PodGroup, Some("g".to_string()), "Deployment/api".to_string())
        );
        assert!(parse_node_id("garbage").is_err());
        assert!(parse_node_id("Node/x/y").is_err());
    }

    #[test]
    fn object_details_has_yaml_summary_and_related() {
        let store = Store::from_fixture("deployment-basic").unwrap();
        let graph = crate::graph::build(&store, &Default::default());
        let d = object_details(&store, &graph, "Deployment/payments/web").unwrap();
        assert!(d.yaml.starts_with("apiVersion: apps/v1\nkind: Deployment\n"), "{}", d.yaml);
        assert!(!d.yaml.contains("managedFields"));
        assert!(d.summary.iter().any(|(k, _)| k == "Replicas"));
        assert_eq!(d.related, vec!["Pod/payments/web-7f9c-aaaaa", "Pod/payments/web-7f9c-bbbbb"]);
    }

    #[test]
    fn pod_group_details_come_from_graph_node() {
        let store = Store::from_fixture("podgroup").unwrap();
        let graph = crate::graph::build(&store, &Default::default());
        let d = object_details(&store, &graph, "PodGroup/g/Deployment/api").unwrap();
        assert_eq!(d.yaml, "");
        assert!(d.summary.iter().any(|(k, v)| k == "Pods" && v == "7"));
        assert!(d.related.contains(&"Deployment/g/api".to_string()));
    }

    #[test]
    fn missing_object_is_not_found() {
        let store = Store::default();
        let err = object_details(&store, &Graph::default(), "Pod/a/b").unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
    }

    #[test]
    fn events_are_sorted_newest_first() {
        use k8s_openapi::api::core::v1::Event;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time};
        let mk = |name: &str, ts: &str| Event {
            metadata: ObjectMeta {
                name: Some(name.into()),
                ..Default::default()
            },
            type_: Some("Warning".into()),
            reason: Some("BackOff".into()),
            message: Some("restarting".into()),
            count: Some(3),
            last_timestamp: Some(Time(ts.parse().expect("rfc3339 timestamp"))),
            ..Default::default()
        };
        let mut map = std::collections::BTreeMap::new();
        map.insert("old".to_string(), mk("old", "2026-09-17T09:00:00Z"));
        map.insert("new".to_string(), mk("new", "2026-09-17T10:00:00Z"));
        let list = events_to_list(&map);
        assert_eq!(list.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["new", "old"]);
        assert_eq!(list[0].type_, "Warning");
        assert_eq!(list[0].count, 3);
    }

    #[test]
    fn events_fall_back_to_event_time_and_sort_missing_last() {
        use k8s_openapi::api::core::v1::Event;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::{MicroTime, ObjectMeta, Time};
        let base = |name: &str| Event {
            metadata: ObjectMeta {
                name: Some(name.into()),
                ..Default::default()
            },
            type_: Some("Normal".into()),
            reason: Some("Scheduled".into()),
            message: Some("ok".into()),
            count: Some(1),
            ..Default::default()
        };
        let event_time_only = Event {
            event_time: Some(MicroTime("2026-09-17T11:00:00Z".parse().expect("rfc3339 timestamp"))),
            ..base("has-event-time")
        };
        let last_timestamp_only = Event {
            last_timestamp: Some(Time("2026-09-17T10:00:00Z".parse().expect("rfc3339 timestamp"))),
            ..base("has-last-timestamp")
        };
        let no_timestamp = base("no-timestamp");

        let mut map = std::collections::BTreeMap::new();
        map.insert("has-event-time".to_string(), event_time_only);
        map.insert("has-last-timestamp".to_string(), last_timestamp_only);
        map.insert("no-timestamp".to_string(), no_timestamp);

        let list = events_to_list(&map);
        assert_eq!(
            list.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["has-event-time", "has-last-timestamp", "no-timestamp"]
        );
        assert!(
            list[0].last_timestamp.is_some(),
            "event-time fallback should populate last_timestamp"
        );
    }
}
