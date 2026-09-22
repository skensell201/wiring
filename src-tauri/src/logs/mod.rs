//! Container log streaming (spec: docs/superpowers/specs/2026-09-21-pod-logs-design.md).

pub mod pump;
pub mod session;
pub mod targets;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Lines fetched per container when a stream starts.
pub const TAIL_LINES: i64 = 500;
/// Concurrent streams per log session; a workload with more pods is `truncated`.
pub const MAX_STREAMS: usize = 64;

/// One `(pod, container)` a log session streams.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct LogTarget {
    pub namespace: String,
    pub pod: String,
    /// `metadata.uid` (empty when missing). Part of the identity so a pod recreated under the
    /// same name (StatefulSet, DaemonSet) is a new target: its old stream stops, a new one
    /// starts.
    pub uid: String,
    pub container: String,
    pub init: bool,
    /// `status.containerStatuses[].restartCount` (0 when missing). Also part of the identity: a
    /// crashing container's follow stream ends with its run, and the next run is a new target,
    /// so the session reattaches instead of going quiet.
    pub restarts: i32,
}

/// One log line tagged with the pod and container it came from (merged workload streams).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub pod: String,
    pub container: String,
    /// The raw line; starts with the RFC 3339 timestamp when `timestamps` was requested.
    pub text: String,
}

/// What a log session pushes through its channel (IPC contract "Logs").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LogMessage {
    Lines {
        session_id: u32,
        lines: Vec<LogLine>,
    },
    Started {
        session_id: u32,
        pod: String,
        container: String,
    },
    Ended {
        session_id: u32,
        pod: String,
        container: String,
    },
    Error {
        session_id: u32,
        pod: String,
        container: String,
        message: String,
    },
    Truncated {
        session_id: u32,
        limit: usize,
    },
}

/// Where a session's messages go: the Tauri channel in the app, an mpsc sender in tests.
pub trait LogSink: Send + Sync + 'static {
    fn send(&self, msg: LogMessage);
}

impl LogSink for tauri::ipc::Channel<LogMessage> {
    fn send(&self, msg: LogMessage) {
        if let Err(e) = tauri::ipc::Channel::send(self, msg) {
            tracing::debug!(error = %e, "log channel closed");
        }
    }
}

/// A sink that can be shut synchronously. `stop_logs` only aborts the stream tasks, and an
/// abort lands at a task's next `.await`, so a pump mid-flush could still push one batch
/// after the command returned; closing first keeps the contract "nothing after `stop_logs`"
/// (mirrors `session::emitter::ClosableEmitter`).
pub struct ClosableSink {
    inner: Arc<dyn LogSink>,
    closed: AtomicBool,
}

impl ClosableSink {
    pub fn new(inner: Arc<dyn LogSink>) -> Self {
        Self {
            inner,
            closed: AtomicBool::new(false),
        }
    }

    /// Drop every message sent from now on.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

impl LogSink for ClosableSink {
    fn send(&self, msg: LogMessage) {
        if !self.closed.load(Ordering::SeqCst) {
            self.inner.send(msg);
        }
    }
}

impl LogSink for tokio::sync::mpsc::UnboundedSender<LogMessage> {
    fn send(&self, msg: LogMessage) {
        let _ = tokio::sync::mpsc::UnboundedSender::send(self, msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closable_sink_delivers_nothing_after_close() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = ClosableSink::new(Arc::new(tx));
        let msg = LogMessage::Truncated {
            session_id: 1,
            limit: MAX_STREAMS,
        };
        sink.send(msg.clone());
        assert_eq!(rx.try_recv().unwrap(), msg);
        sink.close();
        sink.send(msg);
        assert!(rx.try_recv().is_err(), "messages after close must be dropped");
    }
}
