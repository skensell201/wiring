//! Keeps the open custom table live: one watcher per stream of `ops::targets`, merged, and
//! a debounced `custom_table` event after changes. Nothing here touches the graph store.
//! The task ends when it is aborted (`Session::stop_custom`, a scope switch, disconnect), or
//! once every stream has ended on a fatal error (403, 401, a kind no longer served).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use k8s_openapi::jiff;
use kube::runtime::watcher::{self, Event};
use serde_json::Value;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::ops::{self, Source, WatchStream};
use super::{table, CustomTable};
use crate::discovery::CustomKind;
use crate::error::{AppError, ErrorKind};
use crate::session::emitter::{Emitter, OutEvent};

/// How long changes are gathered before one `custom_table` event: a burst of CR updates
/// (a controller reconciling hundreds of objects) becomes one table, not hundreds.
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// Watch `targets` of `kind` and emit its table on `emitter` after every change.
pub fn spawn(
    source: Arc<dyn Source>,
    kind: CustomKind,
    targets: &[Option<String>],
    multi: bool,
    emitter: Arc<dyn Emitter>,
) -> JoinHandle<()> {
    let streams = targets.iter().map(|t| source.watch(&kind.resource, t.as_deref())).collect();
    tokio::spawn(run(kind, streams, multi, emitter))
}

/// Errors that retrying cannot fix: permission denied, rejected credentials, and a kind
/// that is not (or no longer) served. A 404 mid-watch is only a re-list trigger.
fn fatal_error(e: &watcher::Error) -> Option<AppError> {
    let (error, initial) = match e {
        watcher::Error::InitialListFailed(k) => (AppError::from(k), true),
        watcher::Error::WatchStartFailed(k) | watcher::Error::WatchFailed(k) => (AppError::from(k), false),
        watcher::Error::WatchError(resp) => (crate::error::from_status(resp.code, &resp.message), false),
        _ => return None,
    };
    match error.kind {
        ErrorKind::Forbidden | ErrorKind::Auth => Some(error),
        ErrorKind::NotFound if initial => Some(error),
        _ => None,
    }
}

fn is_fatal(e: &watcher::Error) -> bool {
    fatal_error(e).is_some()
}

/// What the final `custom_table` event says about a watch whose streams all ended on `error`.
fn ended_message(kind: &CustomKind, error: &AppError) -> String {
    match error.kind {
        ErrorKind::Forbidden => ops::no_access(&kind.resource).message,
        ErrorKind::NotFound => format!("{} is no longer served", kind.resource.kind),
        _ => error.message.clone(),
    }
}

/// `stream`, ending right after its first fatal error. The inner watcher is dropped there,
/// so it stops retrying (and requesting) instead of backing off forever.
fn until_fatal(stream: WatchStream) -> WatchStream {
    futures::stream::unfold(Some(stream), |state| async move {
        let mut stream = state?;
        let item = stream.next().await?;
        let rest = match &item {
            Err(e) if is_fatal(e) => None,
            _ => Some(stream),
        };
        Some((item, rest))
    })
    .boxed()
}

fn key(obj: &Value) -> String {
    let meta = &obj["metadata"];
    format!(
        "{}/{}",
        meta["namespace"].as_str().unwrap_or_default(),
        meta["name"].as_str().unwrap_or_default()
    )
}

/// The live objects of one stream, and the re-list in progress (swapped in at `InitDone`, so
/// a re-list never shows a half-empty table and objects deleted meanwhile disappear).
#[derive(Default)]
struct StreamState {
    objects: BTreeMap<String, Value>,
    relist: Option<BTreeMap<String, Value>>,
}

impl StreamState {
    /// Apply one watcher item; `true` when the visible objects changed.
    fn apply(&mut self, item: Result<Event<Value>, watcher::Error>) -> bool {
        match item {
            Ok(Event::Init) => {
                self.relist = Some(BTreeMap::new());
                false
            }
            Ok(Event::InitApply(obj)) => match self.relist.as_mut() {
                Some(pending) => {
                    pending.insert(key(&obj), ops::slim(obj));
                    false
                }
                None => {
                    // No `Init` seen (a watcher always sends one first): apply it directly.
                    self.objects.insert(key(&obj), ops::slim(obj));
                    true
                }
            },
            Ok(Event::InitDone) => {
                self.objects = self.relist.take().unwrap_or_default();
                true
            }
            Ok(Event::Apply(obj)) => {
                self.objects.insert(key(&obj), ops::slim(obj));
                true
            }
            Ok(Event::Delete(obj)) => self.objects.remove(&key(&obj)).is_some(),
            Err(e) if is_fatal(&e) => {
                // The stream ends here: what it showed can no longer be kept up to date.
                self.relist = None;
                !std::mem::take(&mut self.objects).is_empty()
            }
            Err(_) => false, // transient: the watcher retries with backoff, rows stay
        }
    }
}

/// The watch loop over scripted or real `streams` (cluster-free, so it is unit-tested).
pub(crate) async fn run(kind: CustomKind, streams: Vec<WatchStream>, multi: bool, emitter: Arc<dyn Emitter>) {
    let mut states: Vec<StreamState> = streams.iter().map(|_| StreamState::default()).collect();
    let mut events = futures::stream::select_all(
        streams
            .into_iter()
            .enumerate()
            .map(|(i, s)| until_fatal(s).map(move |item| (i, item)).boxed()),
    );
    // When the gathered changes are due to be emitted; `None` while nothing changed.
    let mut due: Option<Instant> = None;
    // The latest fatal error; once every stream has ended, the final event carries it.
    let mut ended: Option<AppError> = None;
    let emit = |states: &[StreamState], error: Option<String>| {
        let all = states.iter().flat_map(|s| s.objects.values());
        let table = table::table(&kind, all, multi, jiff::Timestamp::now());
        emitter.emit(OutEvent::CustomTable(CustomTable {
            resource: kind.resource.clone(),
            table,
            error,
        }));
    };
    loop {
        tokio::select! {
            item = events.next() => {
                let Some((i, item)) = item else { break };
                if let Err(e) = &item {
                    let fatal = fatal_error(e);
                    tracing::warn!(kind = %kind.resource.kind, fatal = fatal.is_some(), error = %e, "custom resource watch error");
                    ended = fatal.or(ended);
                }
                if states[i].apply(item) && due.is_none() {
                    due = Some(Instant::now() + DEBOUNCE);
                }
            }
            // The deadline expression is evaluated even while the branch is disabled.
            _ = tokio::time::sleep_until(due.unwrap_or_else(Instant::now)), if due.is_some() => {
                due = None;
                emit(&states, None);
            }
        }
    }
    // Every stream ended: show the final state, and why, before going quiet.
    let error = ended.map(|e| ended_message(&kind, &e));
    if due.is_some() || error.is_some() {
        emit(&states, error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::ResourceRef;
    use crate::session::emitter::ChannelEmitter;
    use futures::channel::mpsc as fmpsc;
    use kube::runtime::watcher;
    use serde_json::json;
    use tokio::sync::mpsc::UnboundedReceiver;

    type Tx = fmpsc::UnboundedSender<Result<Event<Value>, watcher::Error>>;

    fn kind() -> CustomKind {
        CustomKind {
            resource: ResourceRef {
                group: "x.io".into(),
                version: "v1".into(),
                kind: "Widget".into(),
                plural: "widgets".into(),
                namespaced: true,
            },
            columns: vec![],
        }
    }

    fn obj(ns: &str, name: &str) -> Value {
        json!({ "metadata": { "namespace": ns, "name": name } })
    }

    fn api_error(code: u16) -> kube::Error {
        kube::Error::Api(Box::new(kube::core::Status {
            code,
            message: format!("status {code}"),
            reason: "reason".into(),
            ..Default::default()
        }))
    }

    /// Start `run` over `n` scripted streams.
    fn start(n: usize) -> (Vec<Tx>, UnboundedReceiver<OutEvent>, tokio::task::JoinHandle<()>) {
        let (emitter, rx) = ChannelEmitter::new();
        let (txs, streams): (Vec<Tx>, Vec<WatchStream>) = (0..n)
            .map(|_| {
                let (tx, rx) = fmpsc::unbounded();
                (tx, rx.boxed())
            })
            .unzip();
        let task = tokio::spawn(run(kind(), streams, true, Arc::new(emitter)));
        (txs, rx, task)
    }

    fn send(tx: &Tx, ev: Event<Value>) {
        tx.unbounded_send(Ok(ev)).unwrap();
    }

    fn list(tx: &Tx, objects: &[Value]) {
        send(tx, Event::Init);
        for o in objects {
            send(tx, Event::InitApply(o.clone()));
        }
        send(tx, Event::InitDone);
    }

    /// The names (`ns/name`) of the next emitted table.
    async fn next_table(rx: &mut UnboundedReceiver<OutEvent>) -> CustomTable {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("a custom_table event")
            .expect("emitter alive");
        let OutEvent::CustomTable(t) = ev else {
            panic!("expected CustomTable, got {ev:?}")
        };
        assert_eq!(t.resource.kind, "Widget");
        t
    }

    async fn next_names(rx: &mut UnboundedReceiver<OutEvent>) -> Vec<String> {
        let t = next_table(rx).await;
        assert_eq!(t.error, None, "a live table has no error");
        t.table
            .rows
            .iter()
            .map(|r| format!("{}/{}", r.cells[0].text, r.cells[1].text))
            .collect()
    }

    async fn assert_quiet(rx: &mut UnboundedReceiver<OutEvent>) {
        let got = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await;
        assert!(got.is_err(), "expected no further event, got {got:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_listing_and_a_burst_of_changes_are_one_debounced_event() {
        let (txs, mut rx, task) = start(1);
        list(&txs[0], &[obj("a", "x"), obj("a", "y")]);
        for i in 0..100 {
            send(&txs[0], Event::Apply(obj("a", &format!("n{i:03}"))));
        }
        let names = next_names(&mut rx).await;
        assert_eq!(names.len(), 102);
        assert_quiet(&mut rx).await;
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn deletes_remove_rows_and_a_relist_replaces_what_was_there() {
        let (txs, mut rx, task) = start(1);
        list(&txs[0], &[obj("a", "x"), obj("a", "y")]);
        assert_eq!(next_names(&mut rx).await, vec!["a/x", "a/y"]);
        send(&txs[0], Event::Delete(obj("a", "x")));
        assert_eq!(next_names(&mut rx).await, vec!["a/y"]);
        // A re-list (e.g. after 410 Gone) that no longer has `y` drops it, and nothing is
        // emitted half-way through the re-list.
        send(&txs[0], Event::Init);
        send(&txs[0], Event::InitApply(obj("a", "z")));
        assert_quiet(&mut rx).await;
        send(&txs[0], Event::InitDone);
        assert_eq!(next_names(&mut rx).await, vec!["a/z"]);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn streams_of_several_namespaces_are_merged() {
        let (txs, mut rx, task) = start(2);
        list(&txs[0], &[obj("b", "x")]);
        list(&txs[1], &[obj("a", "y")]);
        assert_eq!(next_names(&mut rx).await, vec!["a/y", "b/x"]);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn transient_errors_keep_the_rows() {
        let (txs, mut rx, task) = start(1);
        list(&txs[0], &[obj("a", "x")]);
        assert_eq!(next_names(&mut rx).await, vec!["a/x"]);
        txs[0].unbounded_send(Err(watcher::Error::WatchFailed(api_error(500)))).unwrap();
        assert_quiet(&mut rx).await;
        assert!(!txs[0].is_closed(), "a transient error keeps the stream");
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_forbidden_stream_is_dropped_with_its_rows_and_the_rest_keep_going() {
        let (txs, mut rx, task) = start(2);
        list(&txs[0], &[obj("a", "x")]);
        list(&txs[1], &[obj("b", "y")]);
        assert_eq!(next_names(&mut rx).await, vec!["a/x", "b/y"]);
        txs[0].unbounded_send(Err(watcher::Error::WatchFailed(api_error(403)))).unwrap();
        assert_eq!(next_names(&mut rx).await, vec!["b/y"]);
        assert!(txs[0].is_closed(), "the forbidden stream is no longer polled (no retry storm)");
        send(&txs[1], Event::Apply(obj("b", "z")));
        assert_eq!(next_names(&mut rx).await, vec!["b/y", "b/z"]);
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn the_task_ends_when_every_stream_has_ended() {
        let (txs, mut rx, task) = start(1);
        list(&txs[0], &[obj("a", "x")]);
        txs[0]
            .unbounded_send(Err(watcher::Error::InitialListFailed(api_error(401))))
            .unwrap();
        // The last state is still flushed before the task returns, saying why it ended.
        let t = next_table(&mut rx).await;
        assert!(t.table.rows.is_empty());
        assert!(t.error.is_some());
        tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn losing_access_everywhere_ends_with_an_rbac_error_state() {
        let (txs, mut rx, task) = start(2);
        list(&txs[0], &[obj("a", "x")]);
        list(&txs[1], &[obj("b", "y")]);
        assert_eq!(next_names(&mut rx).await, vec!["a/x", "b/y"]);
        for tx in &txs {
            tx.unbounded_send(Err(watcher::Error::WatchFailed(api_error(403)))).unwrap();
        }
        let t = next_table(&mut rx).await;
        assert!(t.table.rows.is_empty());
        assert_eq!(t.error.as_deref(), Some("No access to Widget (RBAC)"));
        tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap();
        assert!(rx.try_recv().is_err(), "one final event");
    }

    #[tokio::test(start_paused = true)]
    async fn a_kind_that_is_no_longer_served_ends_with_that_error_state() {
        let (txs, mut rx, task) = start(1);
        // Nothing listed yet, so nothing changed: the error state is still emitted.
        txs[0]
            .unbounded_send(Err(watcher::Error::InitialListFailed(api_error(404))))
            .unwrap();
        let t = next_table(&mut rx).await;
        assert_eq!(t.error.as_deref(), Some("Widget is no longer served"));
        tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap();
    }

    fn heavy(ns: &str, name: &str) -> Value {
        json!({
            "metadata": {
                "namespace": ns, "name": name,
                "creationTimestamp": "2026-10-03T12:00:00Z",
                "managedFields": [{ "manager": "kubectl", "fieldsV1": { "f:spec": {} } }],
                "annotations": {
                    "kubectl.kubernetes.io/last-applied-configuration": "{\"huge\":true}",
                    "team": "web"
                }
            },
            "spec": { "size": 3 },
            "status": { "conditions": [{ "type": "Ready", "status": "True" }] }
        })
    }

    #[test]
    fn stored_objects_drop_managed_fields_and_the_last_applied_annotation() {
        let mut state = StreamState::default();
        state.apply(Ok(Event::Init));
        state.apply(Ok(Event::InitApply(heavy("a", "x"))));
        state.apply(Ok(Event::InitDone));
        state.apply(Ok(Event::Apply(heavy("a", "y"))));
        assert_eq!(state.objects.len(), 2);
        for stored in state.objects.values() {
            assert!(stored["metadata"].get("managedFields").is_none(), "{stored}");
            let annotations = stored["metadata"]["annotations"].as_object().unwrap();
            assert!(!annotations.contains_key("kubectl.kubernetes.io/last-applied-configuration"));
            assert_eq!(annotations["team"], "web", "other annotations stay");
            assert_eq!(stored["spec"]["size"], 3);
        }
        // The rows are what the full objects give.
        let now = "2026-10-06T12:00:00Z".parse().unwrap();
        let full = [heavy("a", "x"), heavy("a", "y")];
        assert_eq!(
            table::table(&kind(), state.objects.values(), true, now),
            table::table(&kind(), &full, true, now)
        );
    }
}
