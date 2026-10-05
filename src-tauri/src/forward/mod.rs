//! Port-forwarding (spec: docs/superpowers/specs/2026-10-05-port-forward-design.md).

pub mod manager;
pub mod resolve;

use serde::{Deserialize, Serialize};

use crate::store::Kind;

/// What a forward points at: a Pod, a Service or a workload in `namespace`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ForwardTarget {
    pub kind: Kind,
    pub namespace: String,
    pub name: String,
}

/// One remote port the dialog offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOption {
    pub port: u16,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardStatus {
    /// The last connection went through (or none was made yet and a pod is ready).
    Active,
    NoReadyPod,
    /// A Pod target that no longer exists.
    PodGone,
    Error,
}

/// A running forward as the frontend sees it (`forwards_changed`, `start_forward`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    pub id: u32,
    pub node_id: String,
    /// `"Service web"`: kind and name, for the popover and toasts.
    pub target_label: String,
    pub remote_port: u16,
    pub local_port: u16,
    /// The pod that served (or would serve) the latest connection.
    pub pod: Option<String>,
    pub status: ForwardStatus,
    /// Set with `status: error`.
    pub message: Option<String>,
}
