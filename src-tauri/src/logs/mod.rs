//! Container log streaming (spec: docs/superpowers/specs/2026-09-21-pod-logs-design.md).

pub mod pump;
pub mod session;
pub mod targets;

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
    pub container: String,
    pub init: bool,
}

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

impl LogSink for tokio::sync::mpsc::UnboundedSender<LogMessage> {
    fn send(&self, msg: LogMessage) {
        let _ = tokio::sync::mpsc::UnboundedSender::send(self, msg);
    }
}
