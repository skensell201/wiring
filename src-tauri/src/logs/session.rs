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
    let task = tokio::spawn(run(id, client, shared, pods, req, initial, sink.clone()));
    Ok(LogSession {
        sink,
        _task: AbortOnDrop(task),
    })
}

async fn run(
    id: u32,
    client: Client,
    shared: Shared,
    mut pods: broadcast::Receiver<()>,
    req: LogRequest,
    initial: Vec<LogTarget>,
    sink: Arc<ClosableSink>,
) {
    let mut streams: HashMap<LogTarget, AbortOnDrop> = HashMap::new();
    let mut truncated_reported = false;
    let mut wanted = initial;
    loop {
        let running: HashSet<LogTarget> = streams.keys().cloned().collect();
        let (start, stop, truncated) = diff_targets(&running, &wanted);
        for t in stop {
            streams.remove(&t); // AbortOnDrop
        }
        for t in start {
            let sink: Arc<dyn LogSink> = sink.clone();
            let handle = tokio::spawn(stream_one(id, client.clone(), t.clone(), req.previous, req.timestamps, sink));
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
    use super::*;

    fn t(pod: &str) -> LogTarget {
        LogTarget {
            namespace: "n".into(),
            pod: pod.into(),
            uid: format!("uid-{pod}"),
            container: "c".into(),
            init: false,
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
