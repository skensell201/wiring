//! One live connection to a cluster: watchers, store, graph, events.

pub mod emitter;
pub mod reducer;
pub mod shared;
pub mod watch;

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use futures::StreamExt;
use k8s_openapi::api::core::v1::{Event as CoreEvent, Namespace};
use kube::api::{Api, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig, KubeconfigError};
use kube::runtime::watcher::{self, watcher, Event};
use kube::runtime::WatchStreamExt;
use kube::{Client, Config};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::{status::summary, Graph, NodeId};
use crate::store::{Kind, Store};
use emitter::{Emitter, K8sEvent, ObjectEvents, OutEvent};
use reducer::{spawn_reducer, ReducerConfig, ReducerMsg};
use shared::Shared;
use watch::{app_error_from_kube, spawn_all};

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

/// Map a kubeconfig-loading error to an `ErrorKind` by variant, rather than lumping everything
/// under `Auth`. These variants never embed raw file content, so `e.to_string()` is safe to
/// show as-is.
fn app_error_from_kubeconfig(e: &KubeconfigError) -> AppError {
    let kind = match e {
        // Context/cluster could not be found by name.
        KubeconfigError::CurrentContextNotSet | KubeconfigError::LoadContext(_) | KubeconfigError::LoadClusterOfContext(_) => {
            ErrorKind::NotFound
        }
        // Cert/key loading and parsing — these are what actually authenticate the client.
        KubeconfigError::LoadCertificateAuthority(_)
        | KubeconfigError::LoadClientCertificate(_)
        | KubeconfigError::LoadClientKey(_)
        | KubeconfigError::ParseCertificates(_) => ErrorKind::Auth,
        // Everything else: malformed/unreadable kubeconfig data or config shape issues.
        KubeconfigError::KindMismatch
        | KubeconfigError::ApiVersionMismatch
        | KubeconfigError::FindPath
        | KubeconfigError::ReadConfig(..)
        | KubeconfigError::Parse(_)
        | KubeconfigError::MissingClusterUrl
        | KubeconfigError::ParseClusterUrl(_)
        | KubeconfigError::ParseProxyUrl(_) => ErrorKind::Internal,
    };
    AppError::new(kind, e.to_string())
}

pub struct Session {
    client: Client,
    context: String,
    namespace: Option<String>,
    shared: Shared,
    emitter: Arc<dyn Emitter>,
    reducer_tx: Option<mpsc::Sender<ReducerMsg>>,
    tasks: Vec<JoinHandle<()>>,
    events_task: Option<JoinHandle<()>>,
}

impl Session {
    pub async fn connect(kubeconfig: Kubeconfig, context: &str, emitter: Arc<dyn Emitter>) -> AppResult<(Session, ConnectInfo)> {
        let options = KubeConfigOptions { context: Some(context.to_string()), cluster: None, user: None };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| app_error_from_kubeconfig(&e))?;
        let client = Client::try_from(config).map_err(|e| AppError::new(ErrorKind::Internal, e.to_string()))?;

        let version = client.apiserver_version().await.map_err(|e| app_error_from_kube(&e))?;
        let namespaces = Api::<Namespace>::all(client.clone())
            .list(&ListParams::default())
            .await
            .map_err(|e| app_error_from_kube(&e))?
            .items
            .into_iter()
            .filter_map(|n| n.metadata.name)
            .collect::<Vec<_>>();

        let info = ConnectInfo { context: context.to_string(), server_version: version.git_version, namespaces };
        let session = Session {
            client,
            context: context.to_string(),
            namespace: None,
            shared: Shared::default(),
            emitter,
            reducer_tx: None,
            tasks: vec![],
            events_task: None,
        };
        Ok((session, info))
    }

    pub fn context(&self) -> &str {
        &self.context
    }

    pub fn namespace(&self) -> Option<&str> {
        self.namespace.as_deref()
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
        self.namespace = Some(namespace.to_string());

        let (reducer_tx, reducer_task) = spawn_reducer(ReducerConfig::default(), self.shared.clone(), self.emitter.clone());
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
        if let Some(tx) = &self.reducer_tx {
            tx.send(ReducerMsg::Rebuild).await.map_err(|_| AppError::internal("reducer stopped"))?;
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
        let emitter = self.emitter.clone();
        let node_id = node_id.to_string();
        self.events_task = Some(tokio::spawn(async move {
            let cfg = watcher::Config::default().fields(&format!("involvedObject.uid={uid}"));
            let mut stream = watcher(api, cfg).default_backoff().boxed();
            let mut events: BTreeMap<String, CoreEvent> = BTreeMap::new();
            while let Some(item) = stream.next().await {
                match item {
                    Ok(Event::Init) => events.clear(),
                    Ok(Event::InitApply(e)) | Ok(Event::Apply(e)) => {
                        events.insert(e.metadata.name.clone().unwrap_or_default(), e);
                    }
                    Ok(Event::Delete(e)) => {
                        events.remove(&e.metadata.name.clone().unwrap_or_default());
                    }
                    Ok(Event::InitDone) => {}
                    Err(e) => {
                        tracing::warn!(error = %e, "events watcher error");
                        continue;
                    }
                }
                emitter.emit(OutEvent::ObjectEvents(ObjectEvents { node_id: node_id.clone(), events: events_to_list(&events) }));
            }
        }));
        Ok(())
    }

    fn stop_watchers(&mut self) {
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

/// `"Kind/ns/name"`; cluster-scoped `"Kind//name"`; PodGroup `"PodGroup/ns/OwnerKind/ownerName"`.
pub fn parse_node_id(id: &str) -> AppResult<(Kind, Option<String>, String)> {
    let mut parts = id.splitn(3, '/');
    let (Some(kind), Some(ns), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(AppError::new(ErrorKind::NotFound, format!("malformed node id `{id}`")));
    };
    let kind = if kind == "PodGroup" { Kind::PodGroup } else {
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
        let node = graph.node(node_id).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in graph")))?;
        let info = node.group.clone().unwrap_or(crate::graph::GroupInfo { count: 0, ok: 0, warn: 0, err: 0 });
        let summary = vec![
            ("Owner".to_string(), name),
            ("Namespace".to_string(), ns.unwrap_or_default()),
            ("Pods".to_string(), info.count.to_string()),
            ("Ok".to_string(), info.ok.to_string()),
            ("Warning".to_string(), info.warn.to_string()),
            ("Error".to_string(), info.err.to_string()),
        ];
        return Ok(ObjectDetails { yaml: String::new(), summary, related });
    }
    let obj = store
        .find(kind, ns.as_deref(), &name)
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in store")))?;
    let yaml = serde_yaml_ng::to_string(&obj.to_json_value()).map_err(|e| AppError::internal(e.to_string()))?;
    Ok(ObjectDetails { yaml, summary: summary(obj), related })
}

pub fn events_to_list(events: &BTreeMap<String, CoreEvent>) -> Vec<K8sEvent> {
    let mut list: Vec<(Option<String>, K8sEvent)> = events
        .values()
        .map(|e| {
            // k8s-openapi 0.28 wraps `jiff::Timestamp`; its Display is RFC 3339 ("...Z").
            let last = e.last_timestamp.as_ref().map(|t| t.0.to_string()).or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()));
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

    #[test]
    fn parses_node_ids() {
        assert_eq!(parse_node_id("Pod/payments/web-1").unwrap(), (Kind::Pod, Some("payments".to_string()), "web-1".to_string()));
        assert_eq!(parse_node_id("PersistentVolume//pv-1").unwrap(), (Kind::PersistentVolume, None, "pv-1".to_string()));
        assert_eq!(parse_node_id("PodGroup/g/Deployment/api").unwrap(), (Kind::PodGroup, Some("g".to_string()), "Deployment/api".to_string()));
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
            metadata: ObjectMeta { name: Some(name.into()), ..Default::default() },
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
            metadata: ObjectMeta { name: Some(name.into()), ..Default::default() },
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
        assert!(list[0].last_timestamp.is_some(), "event-time fallback should populate last_timestamp");
    }
}
