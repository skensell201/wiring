//! One log session: a supervised task per `(pod, container)` target, re-derived whenever the
//! reducer changes a Pod, capped at `MAX_STREAMS` (spec §4 "Session").

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use kube::Client;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio_util::compat::FuturesAsyncReadCompatExt;

use crate::error::{AppError, AppResult};
use crate::session::shared::Shared;
use crate::session::watch::AbortOnDrop;

use super::pump::{pump, PumpConfig};
use super::targets::targets;
use super::{ClosableSink, LogMessage, LogSink, LogTarget, MAX_STREAMS, TAIL_LINES};

#[derive(Debug, Clone)]
pub struct LogRequest {
    pub node_id: String,
    pub container: Option<String>,
    pub previous: bool,
    pub timestamps: bool,
}

/// Dropping it aborts every stream; `close()` first so nothing reaches the sink afterwards.
pub struct LogSession {
    sink: Arc<ClosableSink>,
    _task: AbortOnDrop,
}

impl LogSession {
    /// Stop delivering messages now, ahead of the (asynchronous) task abort on drop.
    pub fn close(&self) {
        self.sink.close();
    }
}

/// Streams to start and to stop so that `running` becomes the first `MAX_STREAMS` of `wanted`
/// (in `wanted`'s order). `truncated` says whether anything was cut off.
pub fn diff_targets(running: &HashSet<LogTarget>, wanted: &[LogTarget]) -> (Vec<LogTarget>, Vec<LogTarget>, bool) {
    let truncated = wanted.len() > MAX_STREAMS;
    let keep: HashSet<&LogTarget> = wanted.iter().take(MAX_STREAMS).collect();
    let start = wanted.iter().take(MAX_STREAMS).filter(|t| !running.contains(t)).cloned().collect();
    let stop = running.iter().filter(|t| !keep.contains(t)).cloned().collect();
    (start, stop, truncated)
}

/// Resolve the request once (so an invalid or unknown node fails the command) and spawn the
/// supervising task that owns the streams.
pub fn spawn_log_session(id: u32, client: Client, shared: Shared, req: LogRequest, sink: Arc<dyn LogSink>) -> AppResult<LogSession> {
    // Subscribe before reading the store: a pod change landing between the read and a later
    // subscribe would be lost, while one landing between subscribe and read just costs one
    // redundant re-derive.
    let pods = shared.subscribe_pods();
    let initial = targets(&shared.store(), &req.node_id, req.container.as_deref())?;
    let sink = Arc::new(ClosableSink::new(sink));
    let (previous, timestamps) = (req.previous, req.timestamps);
    let start = move |t: LogTarget, sink: Arc<dyn LogSink>| stream_one(id, client.clone(), t, previous, timestamps, sink);
    let task = tokio::spawn(run(id, shared, pods, req, initial, sink.clone(), start));
    Ok(LogSession {
        sink,
        _task: AbortOnDrop(task),
    })
}

/// `start` makes the future that streams one target; the tests pass a fake for it.
async fn run<S, F>(
    id: u32,
    shared: Shared,
    mut pods: broadcast::Receiver<()>,
    req: LogRequest,
    initial: Vec<LogTarget>,
    sink: Arc<ClosableSink>,
    start_stream: S,
) where
    S: Fn(LogTarget, Arc<dyn LogSink>) -> F + Send + Sync + 'static,
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let mut streams: HashMap<LogTarget, AbortOnDrop> = HashMap::new();
    let mut truncated_reported = false;
    let mut wanted = initial;
    loop {
        let running: HashSet<LogTarget> = streams.keys().cloned().collect();
        let (start, stop, truncated) = diff_targets(&running, &wanted);
        for t in stop {
            // A stream still running is being stopped by us, not by the server, so the pump never
            // reaches its own `ended`; one that already finished has sent `ended` (or `error`).
            if let Some(handle) = streams.remove(&t) {
                if !handle.0.is_finished() {
                    sink.send(LogMessage::Ended {
                        session_id: id,
                        pod: t.pod.clone(),
                        container: t.container.clone(),
                    });
                }
            }
        }
        for t in start {
            let sink: Arc<dyn LogSink> = sink.clone();
            let handle = tokio::spawn(start_stream(t.clone(), sink));
            streams.insert(t, AbortOnDrop(handle));
        }
        if truncated && !truncated_reported {
            truncated_reported = true;
            sink.send(LogMessage::Truncated {
                session_id: id,
                limit: MAX_STREAMS,
            });
        }
        // `previous` is a one-shot fetch: nothing to reconcile once the streams are up.
        if req.previous {
            futures::future::pending::<()>().await;
        }
        // Wait for the next pod change; a lag just means "re-derive" as well.
        match pods.recv().await {
            Ok(()) | Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return,
        }
        // Coalesce a burst of ticks into one re-derive.
        while pods.try_recv().is_ok() {}
        wanted = match targets(&shared.store(), &req.node_id, req.container.as_deref()) {
            Ok(t) => t,
            // The Pod itself is gone: its stream ends by itself; keep whatever is running.
            Err(_) => continue,
        };
    }
}

async fn stream_one(id: u32, client: Client, t: LogTarget, previous: bool, timestamps: bool, sink: Arc<dyn LogSink>) {
    let api: Api<Pod> = Api::namespaced(client, &t.namespace);
    let params = LogParams {
        container: Some(t.container.clone()),
        follow: !previous,
        previous,
        timestamps,
        tail_lines: Some(TAIL_LINES),
        ..LogParams::default()
    };
    match api.log_stream(&t.pod, &params).await {
        Ok(reader) => {
            sink.send(LogMessage::Started {
                session_id: id,
                pod: t.pod.clone(),
                container: t.container.clone(),
            });
            pump(reader.compat(), id, &t.pod, &t.container, PumpConfig::default(), sink.as_ref()).await;
        }
        Err(e) => sink.send(LogMessage::Error {
            session_id: id,
            pod: t.pod.clone(),
            container: t.container.clone(),
            message: AppError::from(&e).message,
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use tokio::sync::mpsc;

    use crate::store::Store;

    use super::*;

    const DEPLOYMENT_WITH_TWO_PODS: &str = "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web, namespace: n }\n---\n\
         apiVersion: apps/v1\nkind: ReplicaSet\nmetadata: { name: web-1, namespace: n, uid: rs, ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: web, uid: d } ] }\n---\n\
         apiVersion: v1\nkind: Pod\nmetadata: { name: web-a, namespace: n, uid: pa, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: web-1, uid: rs } ] }\nspec: { containers: [ { name: c, image: web } ] }\n---\n\
         apiVersion: v1\nkind: Pod\nmetadata: { name: web-b, namespace: n, uid: pb, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: web-1, uid: rs } ] }\nspec: { containers: [ { name: c, image: web } ] }\n";

    fn pod_with_restarts(restarts: i32) -> String {
        format!(
            "apiVersion: v1\nkind: Pod\nmetadata: {{ name: p, namespace: n, uid: u }}\nspec: {{ containers: [ {{ name: c, image: app }} ] }}\n\
             status:\n  containerStatuses: [ {{ name: c, image: app, imageID: '', ready: true, restartCount: {restarts} }} ]\n"
        )
    }

    /// What the fake stream starter returns: a stream future, boxed so both fakes share a type.
    type StreamFuture = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;
    /// The recorded starts, and the starter `run` calls for each target.
    type Recorder = (Arc<Mutex<Vec<LogTarget>>>, StartStream);
    type StartStream = Box<dyn Fn(LogTarget, Arc<dyn LogSink>) -> StreamFuture + Send + Sync>;

    fn shared_with(yaml: &str) -> Shared {
        let shared = Shared::default();
        *shared.store() = Store::from_yaml_docs(yaml).unwrap();
        shared
    }

    fn request(node_id: &str) -> LogRequest {
        LogRequest {
            node_id: node_id.into(),
            container: None,
            previous: false,
            timestamps: false,
        }
    }

    /// A stream starter that records what it was asked to stream. `ends` makes every stream
    /// finish at once (a container that exited); otherwise it runs until aborted.
    fn recorder(ends: bool) -> Recorder {
        let started = Arc::new(Mutex::new(Vec::new()));
        let seen = started.clone();
        let start = move |t: LogTarget, _sink: Arc<dyn LogSink>| {
            seen.lock().unwrap().push(t);
            let fut: StreamFuture = if ends {
                Box::pin(async {})
            } else {
                Box::pin(futures::future::pending::<()>())
            };
            fut
        };
        (started, Box::new(start))
    }

    /// Poll `f` until it holds; log reconciliation is driven by a broadcast the test cannot await.
    async fn until(what: &str, f: impl Fn() -> bool) {
        for _ in 0..500 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn spawn_run(shared: &Shared, node_id: &str, start: StartStream) -> (AbortOnDrop, mpsc::UnboundedReceiver<LogMessage>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let sink = Arc::new(ClosableSink::new(Arc::new(tx)));
        let initial = targets(&shared.store(), node_id, None).unwrap();
        let task = tokio::spawn(run(
            1,
            shared.clone(),
            shared.subscribe_pods(),
            request(node_id),
            initial,
            sink,
            start,
        ));
        (AbortOnDrop(task), rx)
    }

    #[tokio::test]
    async fn a_stream_the_reconciler_stops_reports_ended() {
        let shared = shared_with(DEPLOYMENT_WITH_TWO_PODS);
        let (started, start) = recorder(false);
        let (_task, mut rx) = spawn_run(&shared, "Deployment/n/web", start);
        until("both pods to stream", || started.lock().unwrap().len() == 2).await;

        // web-b is deleted: its stream is stopped, and a stop the server did not make still owes
        // the channel an `ended` (the pump never reaches its own).
        let without_b = DEPLOYMENT_WITH_TWO_PODS.rsplit_once("---").unwrap().0;
        *shared.store() = Store::from_yaml_docs(without_b).unwrap();
        shared.notify_pods_changed();

        let msg = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("no message")
            .unwrap();
        assert_eq!(
            msg,
            LogMessage::Ended {
                session_id: 1,
                pod: "web-b".into(),
                container: "c".into()
            }
        );
        assert_eq!(started.lock().unwrap().len(), 2, "the surviving pod is not restarted");
    }

    #[tokio::test]
    async fn a_container_restart_starts_a_stream_for_the_new_run() {
        let shared = shared_with(&pod_with_restarts(0));
        let (started, start) = recorder(false);
        let (_task, _rx) = spawn_run(&shared, "Pod/n/p", start);
        until("the first run to stream", || started.lock().unwrap().len() == 1).await;

        *shared.store() = Store::from_yaml_docs(&pod_with_restarts(1)).unwrap();
        shared.notify_pods_changed();

        until("the new run to stream", || started.lock().unwrap().len() == 2).await;
        let started = started.lock().unwrap();
        assert_eq!(started[0].restarts, 0);
        assert_eq!(started[1].restarts, 1);
    }

    #[tokio::test]
    async fn a_stream_that_ended_by_itself_is_not_restarted_for_the_same_run() {
        // Restarting it would re-deliver the same `tail_lines` on every pod change — and for a
        // finished Job pod, forever.
        let shared = shared_with(&pod_with_restarts(0));
        let (started, start) = recorder(true);
        let (_task, _rx) = spawn_run(&shared, "Pod/n/p", start);
        until("the stream to start", || started.lock().unwrap().len() == 1).await;

        shared.notify_pods_changed();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(started.lock().unwrap().len(), 1);
    }

    fn t(pod: &str) -> LogTarget {
        LogTarget {
            namespace: "n".into(),
            pod: pod.into(),
            uid: format!("uid-{pod}"),
            container: "c".into(),
            init: false,
            restarts: 0,
        }
    }

    #[test]
    fn diff_treats_a_pod_recreated_under_the_same_name_as_a_new_target() {
        // StatefulSet/DaemonSet pods keep their name across recreation; only the uid changes.
        let running: HashSet<LogTarget> = [t("a")].into_iter().collect();
        let recreated = LogTarget {
            uid: "uid-a-2".into(),
            ..t("a")
        };
        let (start, stop, truncated) = diff_targets(&running, std::slice::from_ref(&recreated));
        assert_eq!(start, vec![recreated]);
        assert_eq!(stop, vec![t("a")]);
        assert!(!truncated);
    }

    #[test]
    fn diff_starts_new_stops_gone_and_keeps_the_rest() {
        let running: HashSet<LogTarget> = [t("a"), t("b")].into_iter().collect();
        let (start, stop, truncated) = diff_targets(&running, &[t("b"), t("c")]);
        assert_eq!(start, vec![t("c")]);
        assert_eq!(stop, vec![t("a")]);
        assert!(!truncated);
    }

    #[test]
    fn diff_caps_at_max_streams_and_flags_truncation() {
        let wanted: Vec<LogTarget> = (0..MAX_STREAMS + 5).map(|i| t(&format!("p{i:03}"))).collect();
        let (start, stop, truncated) = diff_targets(&HashSet::new(), &wanted);
        assert_eq!(start.len(), MAX_STREAMS);
        assert_eq!(start.last().unwrap().pod, format!("p{:03}", MAX_STREAMS - 1));
        assert!(stop.is_empty());
        assert!(truncated);
    }

    #[test]
    fn diff_stops_a_running_stream_that_fell_past_the_cap() {
        // `wanted` is in pod-name order; a running stream now sorted past the cap must stop.
        let running: HashSet<LogTarget> = [t("z")].into_iter().collect();
        let wanted: Vec<LogTarget> = (0..MAX_STREAMS).map(|i| t(&format!("p{i:03}"))).chain([t("z")]).collect();
        let (start, stop, truncated) = diff_targets(&running, &wanted);
        assert_eq!(start.len(), MAX_STREAMS);
        assert_eq!(stop, vec![t("z")]);
        assert!(truncated);
    }
}
