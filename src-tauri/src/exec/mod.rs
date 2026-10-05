//! Interactive shell into a container (spec: docs/superpowers/specs/2026-10-06-exec-terminal-design.md).

pub mod errors;
pub mod session;
pub mod targets;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorKind};

/// The command run in the container: bash when the image has it, else sh (spec §3 "Shell").
pub const SHELL: [&str; 3] = ["sh", "-c", "command -v bash >/dev/null && exec bash || exec sh"];
/// Bounds for a TTY size coming from the frontend.
pub const MAX_COLS: u16 = 1000;
pub const MAX_ROWS: u16 = 1000;

/// A running pod a terminal can open in, with its regular (non-init) containers in spec order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecPod {
    pub name: String,
    pub containers: Vec<String>,
}

/// What an exec session pushes through its channel (IPC contract "Exec"). `data` is base64 so
/// binary output and UTF-8 sequences split across chunks survive the JSON hop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExecMessage {
    Output {
        session_id: u32,
        data: String,
    },
    Ended {
        session_id: u32,
        code: Option<i32>,
        message: Option<String>,
    },
    Error {
        session_id: u32,
        message: String,
    },
}

/// Where a session's messages go: the Tauri channel in the app, an mpsc sender in tests.
pub trait ExecSink: Send + Sync + 'static {
    fn send(&self, msg: ExecMessage);
}

impl ExecSink for tauri::ipc::Channel<ExecMessage> {
    fn send(&self, msg: ExecMessage) {
        if let Err(e) = tauri::ipc::Channel::send(self, msg) {
            tracing::debug!(error = %e, "exec channel closed");
        }
    }
}

impl ExecSink for tokio::sync::mpsc::UnboundedSender<ExecMessage> {
    fn send(&self, msg: ExecMessage) {
        let _ = tokio::sync::mpsc::UnboundedSender::send(self, msg);
    }
}

/// A sink that can be shut synchronously, so nothing reaches the channel after `stop_exec`
/// even though the task abort only lands at its next `.await` (same idea as `logs::ClosableSink`).
pub struct ClosableExecSink {
    inner: Arc<dyn ExecSink>,
    closed: AtomicBool,
}

impl ClosableExecSink {
    pub fn new(inner: Arc<dyn ExecSink>) -> Self {
        Self {
            inner,
            closed: AtomicBool::new(false),
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

impl ExecSink for ClosableExecSink {
    fn send(&self, msg: ExecMessage) {
        if !self.closed.load(Ordering::SeqCst) {
            self.inner.send(msg);
        }
    }
}

pub fn encode_output(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Keystrokes from the frontend arrive base64-encoded.
pub fn decode_input(data: &str) -> AppResult<Vec<u8>> {
    STANDARD
        .decode(data)
        .map_err(|e| AppError::new(ErrorKind::Invalid, format!("terminal input is not base64: {e}")))
}

pub fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(1, MAX_COLS), rows.clamp(1, MAX_ROWS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn messages_are_tagged_camel_case() {
        let v = serde_json::to_value(ExecMessage::Output {
            session_id: 2,
            data: "aGkK".into(),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "type": "output", "sessionId": 2, "data": "aGkK" }));
        let v = serde_json::to_value(ExecMessage::Ended {
            session_id: 2,
            code: Some(3),
            message: None,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "type": "ended", "sessionId": 2, "code": 3, "message": null })
        );
        let v = serde_json::to_value(ExecMessage::Error {
            session_id: 2,
            message: "m".into(),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "type": "error", "sessionId": 2, "message": "m" }));
    }

    #[test]
    fn base64_round_trips_and_rejects_garbage() {
        assert_eq!(encode_output(b"hi\n"), "aGkK");
        assert_eq!(decode_input("aGkK").unwrap(), b"hi\n");
        let err = decode_input("not base64!").unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::Invalid);
    }

    #[test]
    fn terminal_size_is_clamped() {
        assert_eq!(clamp_size(0, 0), (1, 1));
        assert_eq!(clamp_size(80, 24), (80, 24));
        assert_eq!(clamp_size(5000, 5000), (MAX_COLS, MAX_ROWS));
    }

    #[test]
    fn closable_sink_drops_messages_after_close() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = ClosableExecSink::new(Arc::new(tx));
        let msg = ExecMessage::Error {
            session_id: 1,
            message: "x".into(),
        };
        sink.send(msg.clone());
        assert_eq!(rx.try_recv().unwrap(), msg);
        sink.close();
        sink.send(msg);
        assert!(rx.try_recv().is_err());
    }
}
