//! Port-forwarding (spec: docs/superpowers/specs/2026-10-05-port-forward-design.md).

pub mod kube;
pub mod manager;
pub mod resolve;

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::TcpSocket;

use crate::store::Kind;

/// Why `bind_loopback` failed.
pub(crate) enum BindError {
    InUse,
    Other(std::io::Error),
}

/// Bind `127.0.0.1:port` the way a forward needs it, shared by `start` and the port suggestion so
/// a suggested port is never one `start` would reject.
///
/// First without SO_REUSEADDR: with it, BSD/macOS lets us bind 127.0.0.1:P while another process
/// holds 0.0.0.0:P and we would silently steal its loopback traffic. On "address in use" we probe
/// loopback: a wildcard listener accepts loopback connects, so a refused connect means nothing is
/// listening and the address is only held by TIME_WAIT leftovers of a just-stopped forward; then
/// SO_REUSEADDR is safe and lets us rebind at once.
pub(crate) fn bind_loopback(port: u16) -> Result<TcpSocket, BindError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let other = BindError::Other;
    let socket = TcpSocket::new_v4().map_err(other)?;
    socket.set_reuseaddr(false).map_err(other)?;
    match socket.bind(addr) {
        Ok(()) => return Ok(socket),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {}
        Err(e) => return Err(BindError::Other(e)),
    }
    match TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {}
        _ => return Err(BindError::InUse),
    }
    let socket = TcpSocket::new_v4().map_err(other)?;
    socket.set_reuseaddr(true).map_err(other)?;
    socket.bind(addr).map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => BindError::InUse,
        _ => BindError::Other(e),
    })?;
    Ok(socket)
}

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
