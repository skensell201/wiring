//! Port-forwarding (spec: docs/superpowers/specs/2026-10-05-port-forward-design.md).

pub mod kube;
pub mod manager;
pub mod resolve;

use std::net::SocketAddr;
#[cfg(not(target_os = "linux"))]
use std::net::TcpStream;
#[cfg(not(target_os = "linux"))]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::TcpSocket;

use crate::store::Kind;

/// Why `bind_loopback` failed.
pub(crate) enum BindError {
    InUse,
    Other(std::io::Error),
}

// `bind_loopback` takes the loopback address for a forward, and each platform differs in what a
// bind tells about the port:
//
// * Linux: a bind fails while any listener (wildcard included) holds the port, and SO_REUSEADDR
//   is safe there — it is also required, because sockets accepted by a listener without it keep
//   the port blocked from TIME_WAIT even for a later SO_REUSEADDR bind.
// * BSD/macOS: a bind to the loopback address fails while another process holds the wildcard
//   address, so the bind alone tells a free port from a taken one. SO_REUSEADDR would not: with
//   it the bind would succeed and we would silently steal the holder's loopback traffic.
// * Windows: a bind to the loopback address succeeds even while another process holds the
//   wildcard address, so the port's owner has to be found another way.

/// The Linux variant: one bind, with SO_REUSEADDR, and its outcome is the answer.
#[cfg(target_os = "linux")]
pub(crate) fn bind_loopback(port: u16) -> Result<TcpSocket, BindError> {
    let socket = TcpSocket::new_v4().map_err(BindError::Other)?;
    socket.set_reuseaddr(true).map_err(BindError::Other)?;
    match socket.bind(SocketAddr::from(([127, 0, 0, 1], port))) {
        Ok(()) => Ok(socket),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => Err(BindError::InUse),
        Err(e) => Err(BindError::Other(e)),
    }
}

/// The BSD/macOS variant: a bind to the loopback address fails there while another process
/// holds the wildcard address, so the only thing left to tell apart is a listener from TIME_WAIT
/// leftovers. A listener answers a connect, a refused connect means nothing is listening.
#[cfg(all(not(target_os = "linux"), not(target_os = "windows")))]
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

/// The Windows variant: a bind to 127.0.0.1:P succeeds there even while another process holds
/// 0.0.0.0:P, so the bind alone cannot tell a free port from a taken one. The probe is a bind
/// to the wildcard address: it fails while anything at all holds the port, whatever address that
/// holder uses, and it costs no round trip. A connect would not do: Windows answers a connect to
/// a closed loopback port with a timeout rather than a refusal, which would both hide a free port
/// and turn the port suggestion into a scan of thousands of timed-out connects.
///
/// Only once the port is known to be held does a connect tell a listener, which answers, from
/// TIME_WAIT leftovers of a just-stopped forward, which answer nothing: then SO_REUSEADDR is
/// safe and lets us rebind at once.
#[cfg(target_os = "windows")]
pub(crate) fn bind_loopback(port: u16) -> Result<TcpSocket, BindError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let other = BindError::Other;

    // The probe runs before the bind below: our own socket on the loopback address would make
    // the wildcard bind fail.
    let held = port_is_held(port);

    let socket = TcpSocket::new_v4().map_err(other)?;
    socket.set_reuseaddr(false).map_err(other)?;
    match socket.bind(addr) {
        Ok(()) => {
            // Windows lets this bind succeed while a wildcard listener holds the port, so the
            // probe decides: a holder means a conflict, not our port.
            return match held {
                Some(true) => Err(BindError::InUse),
                _ => Ok(socket),
            };
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {}
        Err(e) => return Err(BindError::Other(e)),
    }
    // The port is held by a socket on the loopback address, or by TIME_WAIT leftovers.
    // Only a listener answers a connect.
    if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
        return Err(BindError::InUse);
    }
    // TIME_WAIT leftovers only: SO_REUSEADDR lets us take the port at once.
    let socket = TcpSocket::new_v4().map_err(other)?;
    socket.set_reuseaddr(true).map_err(other)?;
    socket.bind(addr).map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => BindError::InUse,
        _ => BindError::Other(e),
    })?;
    Ok(socket)
}

/// Does anything hold `port`? A bind to the wildcard address fails while any socket has the
/// port, whatever address that socket uses. `None` means the probe failed for a reason of its
/// own and the port's owner stays unknown.
#[cfg(target_os = "windows")]
fn port_is_held(port: u16) -> Option<bool> {
    let socket = TcpSocket::new_v4().ok()?;
    socket.set_reuseaddr(false).ok()?;
    match socket.bind(SocketAddr::from(([0, 0, 0, 0], port))) {
        Ok(()) => Some(false),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => Some(true),
        Err(_) => None,
    }
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
