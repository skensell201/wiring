//! Backend -> frontend push events, abstracted so tests need no Tauri.

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

    #[tokio::test]
    async fn channel_emitter_forwards_events() {
        let (emitter, mut rx) = ChannelEmitter::new();
        emitter.emit(OutEvent::ConnectionState(ConnectionState::Connected));
        let ev = rx.recv().await.unwrap();
        assert!(matches!(ev, OutEvent::ConnectionState(ConnectionState::Connected)));
    }
}
