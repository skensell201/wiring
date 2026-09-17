//! Backend -> frontend push events, abstracted so tests need no Tauri.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::graph::{Graph, GraphDelta, NodeId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Connected,
    Degraded,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct K8sEvent {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub reason: String,
    pub message: String,
    pub count: i32,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEvents {
    pub node_id: NodeId,
    pub events: Vec<K8sEvent>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OutEvent {
    GraphSnapshot(Graph),
    GraphDelta(GraphDelta),
    ObjectEvents(ObjectEvents),
    ConnectionState(ConnectionState),
    ConnectionError(AppError),
}

impl OutEvent {
    /// Tauri event name + JSON payload.
    pub fn into_parts(self) -> (&'static str, serde_json::Value) {
        fn json<T: Serialize>(v: &T) -> serde_json::Value {
            serde_json::to_value(v).unwrap_or(serde_json::Value::Null)
        }
        match self {
            OutEvent::GraphSnapshot(g) => ("graph_snapshot", json(&g)),
            OutEvent::GraphDelta(d) => ("graph_delta", json(&d)),
            OutEvent::ObjectEvents(e) => ("object_events", json(&e)),
            OutEvent::ConnectionState(s) => ("connection_state", json(&s)),
            OutEvent::ConnectionError(e) => ("connection_error", json(&e)),
        }
    }
}

pub trait Emitter: Send + Sync + 'static {
    fn emit(&self, event: OutEvent);
}

/// An emitter that can be switched off. One is created per namespace session: aborting
/// the reducer/watcher tasks only takes effect at their next `.await`, so a task can still
/// push one stale snapshot or delta of the old namespace after the switch. Closing the
/// emitter first makes those late events vanish instead of reaching the frontend.
#[derive(Clone)]
pub struct ClosableEmitter {
    inner: Arc<dyn Emitter>,
    closed: Arc<AtomicBool>,
}

impl ClosableEmitter {
    pub fn new(inner: Arc<dyn Emitter>) -> Self {
        Self {
            inner,
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Drop every event emitted from now on, on every clone of this emitter.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

impl Emitter for ClosableEmitter {
    fn emit(&self, event: OutEvent) {
        if !self.closed.load(Ordering::SeqCst) {
            self.inner.emit(event);
        }
    }
}

/// Test emitter: collects events on an unbounded channel.
pub struct ChannelEmitter {
    tx: mpsc::UnboundedSender<OutEvent>,
}

impl ChannelEmitter {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<OutEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, rx)
    }
}

impl Emitter for ChannelEmitter {
    fn emit(&self, event: OutEvent) {
        let _ = self.tx.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Graph;

    #[test]
    fn out_event_maps_to_event_name_and_json_payload() {
        let (name, payload) = OutEvent::GraphSnapshot(Graph::default()).into_parts();
        assert_eq!(name, "graph_snapshot");
        assert_eq!(payload["nodes"], serde_json::json!([]));
        let (name, payload) = OutEvent::ConnectionState(ConnectionState::Degraded).into_parts();
        assert_eq!(name, "connection_state");
        assert_eq!(payload, serde_json::json!("degraded"));
    }

    #[test]
    fn closable_emitter_drops_events_after_close() {
        let (inner, mut rx) = ChannelEmitter::new();
        let emitter = ClosableEmitter::new(Arc::new(inner));
        emitter.emit(OutEvent::ConnectionState(ConnectionState::Connected));
        assert_eq!(rx.try_recv().unwrap(), OutEvent::ConnectionState(ConnectionState::Connected));
        emitter.close();
        emitter.emit(OutEvent::ConnectionState(ConnectionState::Degraded));
        emitter.emit(OutEvent::GraphSnapshot(Graph::default()));
        assert!(rx.try_recv().is_err(), "events after close must be dropped");
    }

    #[tokio::test]
    async fn channel_emitter_forwards_events() {
        let (emitter, mut rx) = ChannelEmitter::new();
        emitter.emit(OutEvent::ConnectionState(ConnectionState::Connected));
        let ev = rx.recv().await.unwrap();
        assert!(matches!(ev, OutEvent::ConnectionState(ConnectionState::Connected)));
    }
}
