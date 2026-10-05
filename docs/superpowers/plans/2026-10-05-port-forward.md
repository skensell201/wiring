# Port-forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward a local `127.0.0.1` port to a Pod, Service, Deployment, StatefulSet or DaemonSet from the Actions menu, follow ready pods across restarts, and manage the forwards from a header indicator.

**Architecture:** A new backend module `src-tauri/src/forward/` holds pure resolution helpers (`resolve.rs`), a `ForwardManager` that owns one TCP accept loop per forward and talks to the cluster through a `Connector` trait (`manager.rs`), and the real kube-rs connector (`kube.rs`, `Api::<Pod>::portforward` per accepted connection). The manager lives on `Session` (so it survives `select_namespace` and dies with the connection) and pushes `forwards_changed` through the session emitter. The frontend adds IPC types, a store slice, a `ForwardDialog` (opened as a new `ActionDialog` type) and a `ForwardsIndicator` in the header.

**Tech Stack:** Rust (kube 4.2 with `ws`, k8s-openapi 0.28, tokio `net`), tauri-plugin-opener 2 (Rust API only), React 19 + zustand, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-05-port-forward-design.md`. Branch: `feat/port-forward` (already checked out).

---

## File map

| File | Responsibility |
|---|---|
| `src-tauri/Cargo.toml` | kube `ws`, tokio `net`, `tauri-plugin-opener` |
| `src-tauri/src/lib.rs` | `pub mod forward;`, register the opener plugin |
| `src-tauri/src/forward/mod.rs` | `ForwardTarget`, `PortOption`, `ForwardStatus`, `Forward` |
| `src-tauri/src/forward/resolve.rs` | pure: `target`, `ports`, `serving`, `pick_pod`, `service_target_port`, `selector_string`, `suggest_local_port` |
| `src-tauri/src/forward/manager.rs` | `Connector` trait, `Tunnel`, `ConnectError`, `ForwardManager` (accept loop, statuses, stop) |
| `src-tauri/src/forward/kube.rs` | `KubeConnector`: live pod resolution + `portforward` tunnel |
| `src-tauri/src/graph/status.rs` | `pod_ready` becomes `pub(crate)` |
| `src-tauri/src/session/emitter.rs` | `OutEvent::ForwardsChanged` → `forwards_changed` |
| `src-tauri/src/session/mod.rs` | `forwards` field, `forward_ports` / `start_forward` / `stop_forward` / `forward_local_port`, stop all on `shutdown` |
| `src-tauri/src/commands.rs` | `forward_ports`, `suggest_local_port`, `start_forward`, `stop_forward`, `open_forward` |
| `src-tauri/tests/ipc_fixtures.rs`, `src/shared/ipc/fixtures/{forward,port_option}.json` | contract fixtures |
| `docs/ipc-contract.md` | "Port-forward" section, `forwards_changed` event |
| `src-tauri/tests/fixtures/smoke.yaml`, `src-tauri/tests/smoke.rs` | `whoami` Deployment + Service, `exercise_forward` |
| `src/shared/ipc/{types,commands,events}.ts`, `fixtures.test.ts` | TS mirrors, wrappers, event |
| `src/app/store.ts`, `src/app/wireEvents.ts`, `src/app/useGlobalKeys.ts` | `forwards`, `forwardsOpen`, actions, event, Escape |
| `src/features/forward/ForwardDialog.tsx` | remote/local port dialog |
| `src/features/forward/ForwardsIndicator.tsx` | header button + popover |
| `src/features/actions/{actionKinds.ts,ActionsMenu.tsx,ActionDialogs.tsx}` | **Port-forward…** item, dialog routing |
| `src/features/cluster/Header.tsx` | mounts the indicator |
| `README.md` | feature paragraph |

All commit messages end with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
```

---

### Task 1: Dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the crate features and the plugin**

In `src-tauri/Cargo.toml`:
- the `kube` line becomes
  ```toml
  kube = { version = "4.2", default-features = false, features = ["client", "runtime", "rustls-tls", "ring", "oauth", "oidc", "config", "ws"] }
  ```
- the `tokio` line under `[dependencies]` becomes
  ```toml
  tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time", "io-util", "fs", "net"] }
  ```
- after `tauri-plugin-dialog = "2"` add
  ```toml
  tauri-plugin-opener = "2"
  ```

In `src-tauri/src/lib.rs`, the builder becomes:

```rust
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
```

No capability change: the opener is only called from Rust (`open_forward`, Task 4), and Rust-side plugin APIs are not gated by capabilities.

- [ ] **Step 2: Build and test**

Run: `cd src-tauri && rtk proxy cargo build && rtk proxy cargo test`
Expected: builds (kube-client pulls `tokio-tungstenite`); all existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Add kube websockets, tokio net and the opener plugin for port-forwarding

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 2: Forward types and pure resolution

**Files:**
- Create: `src-tauri/src/forward/mod.rs`
- Create: `src-tauri/src/forward/resolve.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod forward;`)
- Modify: `src-tauri/src/graph/status.rs` (`pod_ready` → `pub(crate)`)

- [ ] **Step 1: Types**

Create `src-tauri/src/forward/mod.rs`:

```rust
//! Port-forwarding (spec: docs/superpowers/specs/2026-10-05-port-forward-design.md).

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
```

In `src-tauri/src/lib.rs` add `pub mod forward;` after `pub mod error;`.

In `src-tauri/src/graph/status.rs` change `fn pod_ready(p: &Pod) -> bool {` to `pub(crate) fn pod_ready(p: &Pod) -> bool {`.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/forward/resolve.rs` with only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod(name: &str, phase: &str, ready: bool) -> Pod {
        serde_json::from_value(json!({
            "metadata": { "name": name },
            "spec": { "containers": [ { "name": "app", "ports": [ { "name": "http", "containerPort": 8080 } ] } ] },
            "status": { "phase": phase, "conditions": [ { "type": "Ready", "status": if ready { "True" } else { "False" } } ] }
        }))
        .unwrap()
    }

    fn service(ports: serde_json::Value) -> Service {
        serde_json::from_value(json!({ "metadata": { "name": "s" }, "spec": { "ports": ports } })).unwrap()
    }

    const YAML: &str = r#"
apiVersion: v1
kind: Pod
metadata: { name: p, namespace: ns }
spec:
  containers:
    - name: app
      ports: [ { name: http, containerPort: 8080 }, { containerPort: 53, protocol: UDP } ]
    - name: side
      ports: [ { containerPort: 9090 } ]
---
apiVersion: v1
kind: Service
metadata: { name: s, namespace: ns }
spec: { ports: [ { name: web, port: 80, targetPort: http }, { port: 443 }, { port: 53, protocol: UDP } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: d, namespace: ns }
spec:
  selector: { matchLabels: { app: d } }
  template: { metadata: { labels: { app: d } }, spec: { containers: [ { name: d, ports: [ { containerPort: 3000 } ] } ] } }
"#;

    fn opts(v: &[PortOption]) -> Vec<(u16, &str)> {
        v.iter().map(|o| (o.port, o.label.as_str())).collect()
    }

    #[test]
    fn targets_are_the_five_forwardable_kinds_with_a_namespace() {
        assert_eq!(
            target("Service/ns/s").unwrap(),
            ForwardTarget { kind: Kind::Service, namespace: "ns".into(), name: "s".into() }
        );
        for ok in ["Pod/ns/p", "Deployment/ns/d", "StatefulSet/ns/s", "DaemonSet/ns/d"] {
            assert!(target(ok).is_ok(), "{ok}");
        }
        for bad in ["ConfigMap/ns/c", "PodGroup/ns/Deployment/d", "Pod//p"] {
            assert_eq!(target(bad).unwrap_err().kind, ErrorKind::Invalid, "{bad}");
        }
    }

    #[test]
    fn ports_list_tcp_ports_per_kind() {
        let store = Store::from_yaml_docs(YAML).unwrap();
        let t = |id: &str| target(id).unwrap();
        assert_eq!(opts(&ports(&store, &t("Pod/ns/p")).unwrap()), vec![(8080, "8080 (http, app)"), (9090, "9090 (side)")]);
        assert_eq!(opts(&ports(&store, &t("Service/ns/s")).unwrap()), vec![(80, "80 → http (web)"), (443, "443 → 443")]);
        assert_eq!(opts(&ports(&store, &t("Deployment/ns/d")).unwrap()), vec![(3000, "3000 (d)")]);
        assert_eq!(ports(&store, &t("Pod/ns/missing")).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn only_running_ready_pods_serve_and_the_smallest_name_wins() {
        let mut deleting = pod("a-deleting", "Running", true);
        deleting.metadata.deletion_timestamp = Some(serde_json::from_value(json!("2026-10-05T10:00:00Z")).unwrap());
        let pods = vec![pod("c", "Running", true), pod("a-pending", "Pending", true), deleting, pod("a-unready", "Running", false), pod("b", "Running", true)];
        assert_eq!(pick_pod(&pods).and_then(|p| p.metadata.name.as_deref()), Some("b"));
        assert!(pick_pod(&pods[1..4]).is_none());
    }

    #[test]
    fn service_ports_map_to_the_pods_target_port() {
        let p = pod("web-1", "Running", true);
        let svc = service(json!([ { "port": 80, "targetPort": "http" }, { "port": 81, "targetPort": 9000 }, { "port": 82 }, { "port": 83, "targetPort": "nope" } ]));
        assert_eq!(service_target_port(&svc, 80, &p), Ok(8080));
        assert_eq!(service_target_port(&svc, 81, &p), Ok(9000));
        assert_eq!(service_target_port(&svc, 82, &p), Ok(82));
        assert_eq!(service_target_port(&svc, 83, &p), Err("pod web-1 has no port named nope".into()));
        assert_eq!(service_target_port(&svc, 99, &p), Err("service has no port 99".into()));
    }

    #[test]
    fn selector_strings_join_labels_and_refuse_empty_selectors() {
        let labels = BTreeMap::from([("b".to_string(), "2".to_string()), ("a".to_string(), "1".to_string())]);
        assert_eq!(selector_string(&labels).as_deref(), Some("a=1,b=2"));
        assert_eq!(selector_string(&BTreeMap::new()), None);
    }

    #[test]
    fn local_port_suggestions_skip_taken_and_privileged_ports() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        assert_ne!(suggest_local_port(port), port);
        drop(taken);
        assert_eq!(suggest_local_port(port), port);
        assert!(suggest_local_port(80) >= 8080);
    }
}
```

Add `pub mod resolve;` is already in `mod.rs` (Step 1).

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd src-tauri && rtk proxy cargo test --lib forward::resolve`
Expected: FAIL to compile — `target`, `ports`, `pick_pod`, … not found.

- [ ] **Step 4: Implement**

Put above the test module in `src-tauri/src/forward/resolve.rs`:

```rust
//! Pure helpers for port-forwarding: which node ids can be forwarded, the ports a target
//! offers, which pod serves a connection and which local port to suggest.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::{Container, Pod, PodSpec, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::status::pod_ready;
use crate::session::parse_node_id;
use crate::store::{Kind, Object, Store};

use super::{ForwardTarget, PortOption};

pub const FORWARD_KINDS: [Kind; 5] = [Kind::Pod, Kind::Service, Kind::Deployment, Kind::StatefulSet, Kind::DaemonSet];

/// The forward target behind `node_id`; other kinds (and PodGroups) are `invalid`.
pub fn target(node_id: &str) -> AppResult<ForwardTarget> {
    let (kind, namespace, name) = parse_node_id(node_id)?;
    if !FORWARD_KINDS.contains(&kind) {
        return Err(AppError::new(ErrorKind::Invalid, format!("{} cannot be port-forwarded", kind.as_str())));
    }
    let namespace = namespace.ok_or_else(|| AppError::new(ErrorKind::Invalid, format!("`{node_id}` has no namespace")))?;
    Ok(ForwardTarget { kind, namespace, name })
}

/// TCP container ports, labelled `8080 (http, app)` or `9090 (side)`.
fn container_ports(spec: Option<&PodSpec>) -> Vec<PortOption> {
    let containers: &[Container] = spec.map(|s| s.containers.as_slice()).unwrap_or_default();
    containers
        .iter()
        .flat_map(|c| c.ports.as_deref().unwrap_or_default().iter().map(move |p| (c, p)))
        .filter(|(_, p)| p.protocol.as_deref().is_none_or(|pr| pr == "TCP"))
        .filter_map(|(c, p)| {
            let port = u16::try_from(p.container_port).ok()?;
            let label = match &p.name {
                Some(n) => format!("{port} ({n}, {})", c.name),
                None => format!("{port} ({})", c.name),
            };
            Some(PortOption { port, label })
        })
        .collect()
}

/// The remote ports the dialog offers for `t`, from the cached store.
pub fn ports(store: &Store, t: &ForwardTarget) -> AppResult<Vec<PortOption>> {
    let obj = store
        .find(t.kind, Some(&t.namespace), &t.name)
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{}/{}/{} not in store", t.kind.as_str(), t.namespace, t.name)))?;
    Ok(match obj {
        Object::Pod(p) => container_ports(p.spec.as_ref()),
        Object::Deployment(d) => container_ports(d.spec.as_ref().and_then(|s| s.template.spec.as_ref())),
        Object::StatefulSet(s) => container_ports(s.spec.as_ref().and_then(|s| s.template.spec.as_ref())),
        Object::DaemonSet(d) => container_ports(d.spec.as_ref().and_then(|s| s.template.spec.as_ref())),
        Object::Service(s) => s
            .spec
            .as_ref()
            .and_then(|sp| sp.ports.as_deref())
            .unwrap_or_default()
            .iter()
            .filter(|p| p.protocol.as_deref().is_none_or(|pr| pr == "TCP"))
            .filter_map(|p| {
                let port = u16::try_from(p.port).ok()?;
                let target = match &p.target_port {
                    Some(IntOrString::Int(n)) => n.to_string(),
                    Some(IntOrString::String(s)) => s.clone(),
                    None => port.to_string(),
                };
                let name = p.name.as_deref().map(|n| format!(" ({n})")).unwrap_or_default();
                Some(PortOption { port, label: format!("{port} → {target}{name}") })
            })
            .collect(),
        _ => vec![],
    })
}

/// A pod that can take a connection: Running, Ready and not being deleted.
pub fn serving(p: &Pod) -> bool {
    p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running") && pod_ready(p)
}

/// The serving pod with the smallest name, so consecutive connections stick to one pod.
pub fn pick_pod(pods: &[Pod]) -> Option<&Pod> {
    pods.iter().filter(|p| serving(p)).min_by(|a, b| a.metadata.name.cmp(&b.metadata.name))
}

/// The container port Service port `port` reaches on `pod`: a numeric targetPort as is, a named
/// one looked up in the pod's containers, none at all means the same number.
pub fn service_target_port(svc: &Service, port: u16, pod: &Pod) -> Result<u16, String> {
    let sp = svc
        .spec
        .as_ref()
        .and_then(|s| s.ports.as_deref())
        .and_then(|ps| ps.iter().find(|p| p.port == i32::from(port)))
        .ok_or_else(|| format!("service has no port {port}"))?;
    match &sp.target_port {
        None => Ok(port),
        Some(IntOrString::Int(n)) => u16::try_from(*n).map_err(|_| format!("bad targetPort {n}")),
        Some(IntOrString::String(name)) => pod
            .spec
            .iter()
            .flat_map(|s| s.containers.iter())
            .flat_map(|c| c.ports.as_deref().unwrap_or_default())
            .find(|p| p.name.as_deref() == Some(name.as_str()))
            .and_then(|p| u16::try_from(p.container_port).ok())
            .ok_or_else(|| format!("pod {} has no port named {name}", pod.metadata.name.as_deref().unwrap_or_default())),
    }
}

/// `a=1,b=2` for a pod list; `None` for an empty selector, which would match every pod.
pub fn selector_string(labels: &BTreeMap<String, String>) -> Option<String> {
    if labels.is_empty() {
        return None;
    }
    Some(labels.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","))
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// `port` itself when it is unprivileged and free, else the first free port from 8080 (0 if none).
pub fn suggest_local_port(port: u16) -> u16 {
    if port >= 1024 && port_free(port) {
        return port;
    }
    (8080..=u16::MAX).find(|p| port_free(*p)).unwrap_or(0)
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && rtk proxy cargo test --lib forward::resolve && rtk proxy cargo clippy --all-targets -- -D warnings && rtk proxy cargo fmt --check`
Expected: 6 tests pass; clippy and fmt clean (`dead_code` is not reported for `pub` items).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/forward src-tauri/src/lib.rs src-tauri/src/graph/status.rs
git commit -m "$(cat <<'EOF'
Resolve port-forward targets, ports and serving pods

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 3: ForwardManager with a connector trait

**Files:**
- Create: `src-tauri/src/forward/manager.rs`
- Modify: `src-tauri/src/forward/mod.rs` (`pub mod manager;`)
- Modify: `src-tauri/src/session/emitter.rs` (`OutEvent::ForwardsChanged`)

- [ ] **Step 1: The event**

In `src-tauri/src/session/emitter.rs` add `use crate::forward::Forward;`, the variant

```rust
    ForwardsChanged(Vec<Forward>),
```

to `OutEvent`, and the arm

```rust
            OutEvent::ForwardsChanged(f) => ("forwards_changed", json(&f)),
```

to `into_parts`. In `src-tauri/src/forward/mod.rs` add `pub mod manager;` under `pub mod resolve;`.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/forward/manager.rs` with the test module only:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::emitter::ChannelEmitter;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Resolves to whatever `next` holds; `open` returns an in-memory echo tunnel.
    struct Fake {
        next: Mutex<Result<(String, u16), ConnectError>>,
    }

    impl Connector for Fake {
        fn resolve(&self, _: &ForwardTarget, _: u16) -> BoxFuture<'static, Result<(String, u16), ConnectError>> {
            let r = lock(&self.next).clone();
            Box::pin(async move { r })
        }
        fn open(&self, _: &str, _: &str, _: u16) -> BoxFuture<'static, Result<Tunnel, ConnectError>> {
            Box::pin(async {
                let (ours, theirs) = tokio::io::duplex(1024);
                tokio::spawn(async move {
                    let (mut r, mut w) = tokio::io::split(theirs);
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
                Ok(Tunnel { stream: Box::new(ours), keep: Box::new(()) })
            })
        }
    }

    fn manager(next: Result<(String, u16), ConnectError>) -> (ForwardManager, Arc<Fake>, tokio::sync::mpsc::UnboundedReceiver<OutEvent>) {
        let fake = Arc::new(Fake { next: Mutex::new(next) });
        let (emitter, rx) = ChannelEmitter::new();
        (ForwardManager::new(fake.clone(), Arc::new(emitter)), fake, rx)
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    fn svc() -> ForwardTarget {
        ForwardTarget { kind: crate::store::Kind::Service, namespace: "ns".into(), name: "web".into() }
    }

    async fn ping(port: u16) -> std::io::Result<[u8; 4]> {
        let mut c = TcpStream::connect(("127.0.0.1", port)).await?;
        c.write_all(b"ping").await?;
        let mut buf = [0u8; 4];
        c.read_exact(&mut buf).await?;
        Ok(buf)
    }

    #[tokio::test]
    async fn a_forward_tunnels_bytes_and_reports_its_pod() {
        let (mut m, _, mut rx) = manager(Ok(("web-1".into(), 8080)));
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).await.unwrap();
        assert_eq!((f.status, f.pod.as_deref(), f.local_port), (ForwardStatus::Active, Some("web-1"), port));
        assert!(matches!(rx.try_recv().unwrap(), OutEvent::ForwardsChanged(list) if list.len() == 1));
        assert_eq!(&ping(port).await.unwrap(), b"ping");
        assert_eq!(m.local_port(f.id), Some(port));
    }

    #[tokio::test]
    async fn a_taken_local_port_is_a_conflict() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        let err = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict);
        assert_eq!(err.message, format!("port {port} is already in use"));
        assert!(m.list().is_empty());
    }

    #[tokio::test]
    async fn privileged_local_ports_are_invalid() {
        let (mut m, _, _rx) = manager(Ok(("web-1".into(), 8080)));
        assert_eq!(m.start("Service/ns/web", svc(), "Service web".into(), 80, 80).await.unwrap_err().kind, ErrorKind::Invalid);
    }

    #[tokio::test]
    async fn without_a_ready_pod_connections_are_closed_and_the_status_says_why() {
        let (mut m, _, _rx) = manager(Err(ConnectError::NoReadyPod));
        let port = free_port();
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, port).await.unwrap();
        assert_eq!((f.status, f.pod), (ForwardStatus::NoReadyPod, None));
        let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut buf = [0u8; 1];
        assert_eq!(c.read(&mut buf).await.unwrap(), 0, "the connection is closed");
    }

    #[tokio::test]
    async fn each_connection_reselects_the_pod() {
        let (mut m, fake, mut rx) = manager(Ok(("web-1".into(), 8080)));
        let port = free_port();
        m.start("Service/ns/web", svc(), "Service web".into(), 80, port).await.unwrap();
        *lock(&fake.next) = Ok(("web-2".into(), 8080));
        assert_eq!(&ping(port).await.unwrap(), b"ping");
        assert_eq!(m.list()[0].pod.as_deref(), Some("web-2"));
        let last = std::iter::from_fn(|| rx.try_recv().ok()).last().unwrap();
        assert!(matches!(last, OutEvent::ForwardsChanged(list) if list[0].pod.as_deref() == Some("web-2")));
    }

    #[tokio::test]
    async fn errors_carry_their_message() {
        let (mut m, _, _rx) = manager(Err(ConnectError::Failed("forbidden".into())));
        let f = m.start("Service/ns/web", svc(), "Service web".into(), 80, free_port()).await.unwrap();
        assert_eq!((f.status, f.message.as_deref()), (ForwardStatus::Error, Some("forbidden")));
    }

    #[tokio::test]
    async fn stop_closes_the_port_and_stop_all_empties_the_list() {
        let (mut m, _, mut rx) = manager(Ok(("web-1".into(), 8080)));
        let (a, b) = (free_port(), free_port());
        let fa = m.start("Service/ns/web", svc(), "Service web".into(), 80, a).await.unwrap();
        m.start("Service/ns/web", svc(), "Service web".into(), 80, b).await.unwrap();
        m.stop(fa.id);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while TcpStream::connect(("127.0.0.1", a)).await.is_ok() {
            assert!(tokio::time::Instant::now() < deadline, "port {a} still open after stop");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(m.list().len(), 1);
        m.stop_all();
        assert!(m.list().is_empty());
        let last = std::iter::from_fn(|| rx.try_recv().ok()).last().unwrap();
        assert_eq!(last, OutEvent::ForwardsChanged(vec![]));
    }
}
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd src-tauri && rtk proxy cargo test --lib forward::manager`
Expected: FAIL to compile — `ForwardManager`, `Connector`, … not found.

- [ ] **Step 4: Implement**

Put above the test module:

```rust
//! One TCP accept loop per forward; every accepted connection resolves its pod at that moment
//! and gets its own tunnel, which is what makes Service/workload forwards follow restarts.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::session::emitter::{Emitter, OutEvent};
use crate::session::watch::AbortOnDrop;

use super::{Forward, ForwardStatus, ForwardTarget};

pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

/// A byte stream to one pod port; `keep` is whatever must live as long as it (kube's Portforwarder).
pub struct Tunnel {
    pub stream: Box<dyn Duplex>,
    pub keep: Box<dyn std::any::Any + Send>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    NoReadyPod,
    PodGone,
    Failed(String),
}

/// The cluster side of a forward; the tests use an in-memory fake.
pub trait Connector: Send + Sync + 'static {
    /// The pod (name, port) a new connection to `target:remote_port` should reach now.
    fn resolve(&self, target: &ForwardTarget, remote_port: u16) -> BoxFuture<'static, Result<(String, u16), ConnectError>>;
    fn open(&self, namespace: &str, pod: &str, port: u16) -> BoxFuture<'static, Result<Tunnel, ConnectError>>;
}

type Infos = Arc<Mutex<BTreeMap<u32, Forward>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn publish(infos: &Infos, emitter: &dyn Emitter) {
    let list: Vec<Forward> = lock(infos).values().cloned().collect();
    emitter.emit(OutEvent::ForwardsChanged(list));
}

fn outcome(e: &ConnectError) -> (ForwardStatus, Option<String>) {
    match e {
        ConnectError::NoReadyPod => (ForwardStatus::NoReadyPod, None),
        ConnectError::PodGone => (ForwardStatus::PodGone, None),
        ConnectError::Failed(m) => (ForwardStatus::Error, Some(m.clone())),
    }
}

/// What one forward's accept loop and its connections share.
#[derive(Clone)]
struct Ctx {
    id: u32,
    target: ForwardTarget,
    remote_port: u16,
    connector: Arc<dyn Connector>,
    infos: Infos,
    emitter: Arc<dyn Emitter>,
}

impl Ctx {
    /// Record the latest connection attempt; emits only when something visible changed.
    fn set(&self, pod: Option<String>, status: ForwardStatus, message: Option<String>) {
        let changed = {
            let mut map = lock(&self.infos);
            match map.get_mut(&self.id) {
                Some(f) if f.pod != pod || f.status != status || f.message != message => {
                    f.pod = pod;
                    f.status = status;
                    f.message = message;
                    true
                }
                _ => false,
            }
        };
        if changed {
            publish(&self.infos, &*self.emitter);
        }
    }
}

/// The forwards of one connection. Dropping it (with the Session) closes every port.
pub struct ForwardManager {
    connector: Arc<dyn Connector>,
    emitter: Arc<dyn Emitter>,
    infos: Infos,
    tasks: HashMap<u32, AbortOnDrop>,
    next_id: u32,
}

impl ForwardManager {
    pub fn new(connector: Arc<dyn Connector>, emitter: Arc<dyn Emitter>) -> Self {
        Self {
            connector,
            emitter,
            infos: Arc::default(),
            tasks: HashMap::new(),
            next_id: 1,
        }
    }

    /// Bind `127.0.0.1:local_port` and start forwarding it to `target:remote_port`.
    pub async fn start(&mut self, node_id: &str, target: ForwardTarget, target_label: String, remote_port: u16, local_port: u16) -> AppResult<Forward> {
        if local_port < 1024 {
            return Err(AppError::new(ErrorKind::Invalid, "the local port must be between 1024 and 65535"));
        }
        let listener = TcpListener::bind(("127.0.0.1", local_port)).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::AddrInUse => AppError::new(ErrorKind::Conflict, format!("port {local_port} is already in use")),
            _ => AppError::internal(format!("cannot listen on port {local_port}: {e}")),
        })?;
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        // Resolve once up front so the popover shows the pod (or why there is none) right away.
        let (pod, status, message) = match self.connector.resolve(&target, remote_port).await {
            Ok((pod, _)) => (Some(pod), ForwardStatus::Active, None),
            Err(e) => {
                let (s, m) = outcome(&e);
                (None, s, m)
            }
        };
        let info = Forward {
            id,
            node_id: node_id.to_string(),
            target_label,
            remote_port,
            local_port,
            pod,
            status,
            message,
        };
        lock(&self.infos).insert(id, info.clone());
        publish(&self.infos, &*self.emitter);
        let ctx = Ctx {
            id,
            target,
            remote_port,
            connector: self.connector.clone(),
            infos: self.infos.clone(),
            emitter: self.emitter.clone(),
        };
        self.tasks.insert(id, AbortOnDrop(tokio::spawn(accept_loop(listener, ctx))));
        Ok(info)
    }

    /// Close the port and its connections; unknown ids are a no-op.
    pub fn stop(&mut self, id: u32) {
        let removed = lock(&self.infos).remove(&id).is_some();
        self.tasks.remove(&id); // dropping aborts the loop, its JoinSet and the listener
        if removed {
            publish(&self.infos, &*self.emitter);
        }
    }

    pub fn stop_all(&mut self) {
        if self.tasks.is_empty() {
            return;
        }
        lock(&self.infos).clear();
        self.tasks.clear();
        publish(&self.infos, &*self.emitter);
    }

    pub fn list(&self) -> Vec<Forward> {
        lock(&self.infos).values().cloned().collect()
    }

    pub fn local_port(&self, id: u32) -> Option<u16> {
        lock(&self.infos).get(&id).map(|f| f.local_port)
    }
}

/// Accept until aborted; connections live in the JoinSet, so aborting the loop ends them too.
async fn accept_loop(listener: TcpListener, ctx: Ctx) {
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    conns.spawn(serve(socket, ctx.clone()));
                }
                // e.g. out of file descriptors: back off instead of spinning
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
        }
    }
}

async fn serve(mut socket: TcpStream, ctx: Ctx) {
    let tunnel = async {
        let (pod, port) = ctx.connector.resolve(&ctx.target, ctx.remote_port).await?;
        let tunnel = ctx.connector.open(&ctx.target.namespace, &pod, port).await?;
        Ok::<_, ConnectError>((pod, tunnel))
    }
    .await;
    match tunnel {
        Ok((pod, mut tunnel)) => {
            ctx.set(Some(pod), ForwardStatus::Active, None);
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut tunnel.stream).await;
        }
        // Dropping `socket` closes the client's connection.
        Err(e) => {
            let (status, message) = outcome(&e);
            ctx.set(None, status, message);
        }
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && rtk proxy cargo test --lib forward::manager && rtk proxy cargo test --lib session::emitter && rtk proxy cargo clippy --all-targets -- -D warnings && rtk proxy cargo fmt --check`
Expected: 7 manager tests pass; emitter tests still pass; clippy and fmt clean.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/forward src-tauri/src/session/emitter.rs
git commit -m "$(cat <<'EOF'
Run port-forwards as accept loops that reselect the pod per connection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 4: Kube connector, session methods, Tauri commands

**Files:**
- Create: `src-tauri/src/forward/kube.rs`
- Modify: `src-tauri/src/forward/mod.rs` (`pub mod kube;`)
- Modify: `src-tauri/src/session/mod.rs`
- Modify: `src-tauri/src/commands.rs`

This task is integration code that needs a cluster; it is covered by the smoke test (Task 6). The pure parts it relies on are already tested.

- [ ] **Step 1: The kube connector**

In `src-tauri/src/forward/mod.rs` add `pub mod kube;`. Create `src-tauri/src/forward/kube.rs`:

```rust
//! The real connector: resolves pods with live API reads (forwards outlive the namespace the
//! store caches) and opens one `pods/portforward` stream per connection.

use std::collections::BTreeMap;

use futures::future::BoxFuture;
use futures::FutureExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{Pod, Service};
use kube::api::{Api, ListParams, Portforwarder};
use kube::Client;

use crate::error::AppError;
use crate::store::Kind;

use super::manager::{ConnectError, Connector, Tunnel};
use super::resolve::{pick_pod, selector_string, service_target_port, serving};
use super::ForwardTarget;

pub struct KubeConnector {
    client: Client,
}

impl KubeConnector {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

fn failed(e: kube::Error) -> ConnectError {
    ConnectError::Failed(AppError::from(&e).message)
}

/// Aborts kube's background forwarding task with the tunnel.
struct AbortOnDropPf(Portforwarder);

impl Drop for AbortOnDropPf {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn list_pods(pods: &Api<Pod>, labels: &BTreeMap<String, String>) -> Result<Vec<Pod>, ConnectError> {
    let Some(selector) = selector_string(labels) else { return Ok(vec![]) };
    Ok(pods.list(&ListParams::default().labels(&selector)).await.map_err(failed)?.items)
}

async fn resolve_live(client: Client, t: ForwardTarget, remote_port: u16) -> Result<(String, u16), ConnectError> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), &t.namespace);
    let labels = match t.kind {
        Kind::Pod => {
            let Some(pod) = pods.get_opt(&t.name).await.map_err(failed)? else { return Err(ConnectError::PodGone) };
            return if serving(&pod) { Ok((t.name, remote_port)) } else { Err(ConnectError::NoReadyPod) };
        }
        Kind::Service => {
            let svc = Api::<Service>::namespaced(client, &t.namespace).get(&t.name).await.map_err(failed)?;
            let labels = svc.spec.as_ref().and_then(|s| s.selector.clone()).unwrap_or_default();
            let list = list_pods(&pods, &labels).await?;
            let pod = pick_pod(&list).ok_or(ConnectError::NoReadyPod)?;
            let port = service_target_port(&svc, remote_port, pod).map_err(ConnectError::Failed)?;
            return Ok((pod.metadata.name.clone().unwrap_or_default(), port));
        }
        // Like `kubectl port-forward deploy/x`: the workload's selector picks the pods.
        Kind::Deployment => Api::<Deployment>::namespaced(client, &t.namespace)
            .get(&t.name)
            .await
            .map_err(failed)?
            .spec
            .and_then(|s| s.selector.match_labels),
        Kind::StatefulSet => Api::<StatefulSet>::namespaced(client, &t.namespace)
            .get(&t.name)
            .await
            .map_err(failed)?
            .spec
            .and_then(|s| s.selector.match_labels),
        Kind::DaemonSet => Api::<DaemonSet>::namespaced(client, &t.namespace)
            .get(&t.name)
            .await
            .map_err(failed)?
            .spec
            .and_then(|s| s.selector.match_labels),
        other => return Err(ConnectError::Failed(format!("{} cannot be port-forwarded", other.as_str()))),
    }
    .unwrap_or_default();
    let list = list_pods(&pods, &labels).await?;
    let pod = pick_pod(&list).ok_or(ConnectError::NoReadyPod)?;
    Ok((pod.metadata.name.clone().unwrap_or_default(), remote_port))
}

impl Connector for KubeConnector {
    fn resolve(&self, target: &ForwardTarget, remote_port: u16) -> BoxFuture<'static, Result<(String, u16), ConnectError>> {
        resolve_live(self.client.clone(), target.clone(), remote_port).boxed()
    }

    fn open(&self, namespace: &str, pod: &str, port: u16) -> BoxFuture<'static, Result<Tunnel, ConnectError>> {
        let api: Api<Pod> = Api::namespaced(self.client.clone(), namespace);
        let pod = pod.to_string();
        async move {
            let mut pf = api.portforward(&pod, &[port]).await.map_err(failed)?;
            let stream = pf
                .take_stream(port)
                .ok_or_else(|| ConnectError::Failed(format!("no stream for port {port}")))?;
            Ok(Tunnel {
                stream: Box::new(stream),
                keep: Box::new(AbortOnDropPf(pf)),
            })
        }
        .boxed()
    }
}
```

- [ ] **Step 2: Session**

In `src-tauri/src/session/mod.rs`:

- imports: `use crate::forward::kube::KubeConnector;`, `use crate::forward::manager::ForwardManager;`, `use crate::forward::{self, Forward, PortOption};`
- `Session` gains the field (after `next_log_id`):
  ```rust
      /// Port-forwards outlive namespace switches; they end with the connection.
      forwards: ForwardManager,
  ```
- `fn new(client: Client, emitter: Arc<dyn Emitter>) -> Session` builds it before `client` is moved:
  ```rust
      fn new(client: Client, emitter: Arc<dyn Emitter>) -> Session {
          let forwards = ForwardManager::new(Arc::new(KubeConnector::new(client.clone())), emitter.clone());
          Session {
              client,
              shared: Shared::default(),
              ns_emitter: ClosableEmitter::new(emitter.clone()),
              emitter,
              reducer_tx: None,
              tasks: vec![],
              events_task: None,
              logs: HashMap::new(),
              next_log_id: 1,
              forwards,
          }
      }
  ```
- methods, after `stop_logs`:
  ```rust
      /// The remote ports the Port-forward dialog offers for `node_id`.
      pub fn forward_ports(&self, node_id: &str) -> AppResult<Vec<PortOption>> {
          let target = forward::resolve::target(node_id)?;
          forward::resolve::ports(&self.shared.store(), &target)
      }

      pub async fn start_forward(&mut self, node_id: &str, remote_port: u16, local_port: u16) -> AppResult<Forward> {
          let target = forward::resolve::target(node_id)?;
          let label = format!("{} {}", target.kind.as_str(), target.name);
          self.forwards.start(node_id, target, label, remote_port, local_port).await
      }

      pub fn stop_forward(&mut self, id: u32) {
          self.forwards.stop(id);
      }

      pub fn forward_local_port(&self, id: u32) -> Option<u16> {
          self.forwards.local_port(id)
      }
  ```
- `shutdown` stops the forwards before announcing the disconnect (context switches go through `shutdown` too — `connect` calls it on the old session; app exit closes the sockets with the process):
  ```rust
      pub fn shutdown(&mut self) {
          self.stop_watchers();
          self.forwards.stop_all();
          self.emitter.emit(OutEvent::ConnectionState(emitter::ConnectionState::Disconnected));
      }
  ```

- [ ] **Step 3: Commands**

In `src-tauri/src/commands.rs` add imports `use crate::forward::{Forward, PortOption};` and `use tauri_plugin_opener::OpenerExt;`, then after `stop_logs`:

```rust
#[tauri::command]
pub async fn forward_ports(state: State<'_, AppState>, node_id: String) -> AppResult<Vec<PortOption>> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.forward_ports(&node_id)
}

#[tauri::command]
pub fn suggest_local_port(port: u16) -> u16 {
    crate::forward::resolve::suggest_local_port(port)
}

#[tauri::command]
pub async fn start_forward(state: State<'_, AppState>, node_id: String, remote_port: u16, local_port: u16) -> AppResult<Forward> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.start_forward(&node_id, remote_port, local_port).await
}

/// Unknown ids and a missing session are no-ops (the forward is gone either way).
#[tauri::command]
pub async fn stop_forward(state: State<'_, AppState>, id: u32) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    if let Some(session) = guard.as_mut() {
        session.stop_forward(id);
    }
    Ok(())
}

/// Open `http://localhost:<port>` of forward `id` in the default browser. The URL is built here
/// from the forward's own port, so the webview cannot open arbitrary URLs through this.
#[tauri::command]
pub async fn open_forward(app: AppHandle, state: State<'_, AppState>, id: u32) -> AppResult<()> {
    let port = {
        let guard = state.session.lock().await;
        guard.as_ref().and_then(|s| s.forward_local_port(id))
    }
    .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("no forward {id}")))?;
    app.opener()
        .open_url(format!("http://localhost:{port}"), None::<&str>)
        .map_err(|e| AppError::internal(e.to_string()))
}
```

and register `forward_ports, suggest_local_port, start_forward, stop_forward, open_forward,` in `generate_handler!` after `stop_logs,`.

- [ ] **Step 4: Build and test**

Run: `cd src-tauri && rtk proxy cargo build && rtk proxy cargo test && rtk proxy cargo clippy --all-targets -- -D warnings && rtk proxy cargo fmt --check`
Expected: all green. If `Portforwarder` is not re-exported at `kube::api`, import it from `kube::api::Portforwarder` per `kube-client-4.2.0/src/api/mod.rs` (it is behind the `ws` feature) and note it.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "$(cat <<'EOF'
Wire port-forwards into the session and add their Tauri commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 5: IPC contract and fixtures

**Files:**
- Create: `src/shared/ipc/fixtures/forward.json`, `src/shared/ipc/fixtures/port_option.json`
- Modify: `src-tauri/tests/ipc_fixtures.rs`
- Modify: `docs/ipc-contract.md`

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/tests/ipc_fixtures.rs`:

```rust
#[test]
fn forward_and_port_option() {
    use wiring_lib::forward::{Forward, ForwardStatus, PortOption};
    assert_matches(
        "forward",
        &Forward {
            id: 1,
            node_id: "Service/shop/web".into(),
            target_label: "Service web".into(),
            remote_port: 80,
            local_port: 8080,
            pod: Some("web-6f8d6c8667-2m5mh".into()),
            status: ForwardStatus::Active,
            message: None,
        },
    );
    assert_matches("port_option", &PortOption { port: 8080, label: "8080 → http (web)".into() });
}
```

Run: `cd src-tauri && rtk proxy cargo test --test ipc_fixtures`
Expected: FAIL — fixture files missing.

- [ ] **Step 2: Fixtures**

`src/shared/ipc/fixtures/forward.json`:

```json
{
  "id": 1,
  "nodeId": "Service/shop/web",
  "targetLabel": "Service web",
  "remotePort": 80,
  "localPort": 8080,
  "pod": "web-6f8d6c8667-2m5mh",
  "status": "active",
  "message": null
}
```

`src/shared/ipc/fixtures/port_option.json`:

```json
{ "port": 8080, "label": "8080 → http (web)" }
```

Run: `cd src-tauri && rtk proxy cargo test --test ipc_fixtures`
Expected: PASS.

- [ ] **Step 3: Document**

In `docs/ipc-contract.md`:
- in the Events table, after the `object_events` row add
  ```markdown
  | `forwards_changed` | `Forward[]` | Every running forward, ordered by id, after each start, stop and status change (see [Port-forward](#port-forward)). Empty after a disconnect. |
  ```
- append a section at the end:

  ```markdown
  ## Port-forward

  ### Commands

  | Command | Args | Returns |
  |---|---|---|
  | `forward_ports` | `{ nodeId }` | `PortOption[]` — `{ port, label }`: container ports (TCP) of a Pod or a workload's template, `port → targetPort` of a Service |
  | `suggest_local_port` | `{ port }` | `number` — `port` if ≥ 1024 and free on 127.0.0.1, else the first free port from 8080 |
  | `start_forward` | `{ nodeId, remotePort, localPort }` | `Forward` |
  | `stop_forward` | `{ id }` | `null` — unknown ids are a no-op |
  | `open_forward` | `{ id }` | `null` — opens `http://localhost:<localPort>` in the default browser |

  `nodeId` may be a `Pod`, `Service`, `Deployment`, `StatefulSet` or `DaemonSet` (anything else, and PodGroups, are `invalid`). `localPort` below 1024 is `invalid`; a port already in use is `conflict` ("port N is already in use"). Forwards bind `127.0.0.1` only, survive `select_namespace` and stop on `disconnect` / `connect`.

  Each accepted local connection picks its pod at that moment: a Pod target itself (Running and Ready), otherwise the ready pod with the smallest name among those the Service's or workload's selector matches. For a Service, `remotePort` is a Service port mapped to its `targetPort` (a number, or a name looked up in the chosen pod's container ports). A connection that finds no pod is closed and sets the status.

  ### `Forward`

  `{ id, nodeId, targetLabel, remotePort, localPort, pod: string | null, status, message: string | null }`, `status` ∈ `active`, `noReadyPod`, `podGone` (a Pod target that no longer exists), `error` (with `message`, e.g. RBAC without `pods/portforward`). Fixtures: `forward.json`, `port_option.json`.
  ```

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc/fixtures/forward.json src/shared/ipc/fixtures/port_option.json src-tauri/tests/ipc_fixtures.rs docs/ipc-contract.md
git commit -m "$(cat <<'EOF'
Document the port-forward commands and the forwards_changed event

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 6: Smoke test

**Files:**
- Modify: `src-tauri/tests/fixtures/smoke.yaml`
- Modify: `src-tauri/tests/smoke.rs`

- [ ] **Step 1: An HTTP workload in the fixture**

Append to `src-tauri/tests/fixtures/smoke.yaml` (`traefik/whoami` answers every request with `Hostname: <pod>`, which tells the test which pod served it):

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: whoami, namespace: wiring-smoke }
spec:
  replicas: 2
  selector: { matchLabels: { app: whoami } }
  template:
    metadata: { labels: { app: whoami } }
    spec:
      containers:
        - name: whoami
          image: traefik/whoami:v1.10
          ports: [ { name: http, containerPort: 80 } ]
          readinessProbe: { httpGet: { path: /, port: http } }
---
apiVersion: v1
kind: Service
metadata: { name: whoami, namespace: wiring-smoke }
spec: { selector: { app: whoami }, ports: [ { name: web, port: 8080, targetPort: http } ] }
```

- [ ] **Step 2: Exercise the forward**

In `src-tauri/tests/smoke.rs`:
- extend the module doc's first sentence: `… the rollout actions (scale / restart / history / rollback), port-forwarding (Service, pod failover, stop) and log streaming …`
- imports: `use tokio::io::{AsyncReadExt, AsyncWriteExt};` and `use wiring_lib::forward::resolve::suggest_local_port;`
- add before `exercise_logs`:

```rust
const WHOAMI_SVC: &str = "Service/wiring-smoke/whoami";

/// One HTTP/1.0 request through the forward; the whole response.
async fn http_get(port: u16) -> std::io::Result<String> {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    s.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").await?;
    let mut out = String::new();
    tokio::time::timeout(Duration::from_secs(10), s.read_to_string(&mut out))
        .await
        .map_err(|_| std::io::Error::other("timeout"))??;
    Ok(out)
}

/// The pod whoami says served the request.
fn served_by(body: &str) -> Option<String> {
    body.lines().find_map(|l| l.strip_prefix("Hostname: ")).map(str::to_owned)
}

async fn exercise_forward(session: &mut Session, context: &str) {
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "deployment/whoami", "--timeout=180s"]);
    let ports = session.forward_ports(WHOAMI_SVC).unwrap();
    assert_eq!(ports.iter().map(|p| p.port).collect::<Vec<_>>(), vec![8080], "{ports:?}");
    assert_eq!(session.start_forward(CONFIGMAP_ID, 80, 18080).await.unwrap_err().kind, ErrorKind::Invalid);

    let local = suggest_local_port(18080);
    let fwd = session.start_forward(WHOAMI_SVC, 8080, local).await.unwrap();
    assert_eq!(session.start_forward(WHOAMI_SVC, 8080, local).await.unwrap_err().kind, ErrorKind::Conflict);

    let body = http_get(local).await.expect("a response through the forward");
    let first = served_by(&body).unwrap_or_else(|| panic!("no Hostname in {body}"));

    // The serving pod goes away: new connections must reach the other one.
    kubectl(context, &["-n", NAMESPACE, "delete", "pod", &first, "--wait=false"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(h) = http_get(local).await.ok().and_then(|b| served_by(&b)) {
            if h != first {
                break;
            }
        }
        assert!(tokio::time::Instant::now() < deadline, "the forward never moved off {first}");
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    session.stop_forward(fwd.id);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::net::TcpStream::connect(("127.0.0.1", local)).await.is_ok() {
        assert!(tokio::time::Instant::now() < deadline, "port {local} still open after stop");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
```

- in `graph_snapshot_reflects_applied_fixture`, call it between the rollout and log steps:

```rust
    exercise_rollout(&session, &mut rx, &mut graph, &context).await;
    exercise_forward(&mut session, &context).await;
    exercise_logs(&mut session, &context).await;
```

- [ ] **Step 3: Run it (docker-desktop only)**

Run: `cd src-tauri && WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored --nocapture`
Expected: PASS. Only the `docker-desktop` context and the `wiring-smoke` namespace are touched. Then `rtk proxy cargo test` (smoke ignored) stays green.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/fixtures/smoke.yaml src-tauri/tests/smoke.rs
git commit -m "$(cat <<'EOF'
Smoke-test a Service forward, pod failover and stop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 7: Frontend IPC types and commands

**Files:**
- Modify: `src/shared/ipc/types.ts`
- Modify: `src/shared/ipc/commands.ts`
- Modify: `src/shared/ipc/fixtures.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/shared/ipc/fixtures.test.ts` add the imports

```ts
import forward from "./fixtures/forward.json";
import portOption from "./fixtures/port_option.json";
```

add `isForward, isPortOption` to the import from `./types`, and inside the `describe`:

```ts
  it("forward", () => expect(isForward(forward)).toBe(true));
  it("port_option", () => expect(isPortOption(portOption)).toBe(true));
  it("rejects a forward with an unknown status", () => {
    expect(isForward({ ...forward, status: "sleeping" })).toBe(false);
  });
```

Run: `pnpm test -- src/shared/ipc`
Expected: FAIL — `isForward` not exported.

- [ ] **Step 2: Types and guards**

In `src/shared/ipc/types.ts`, after the `Revision` interface:

```ts
export const FORWARD_STATUSES = ["active", "noReadyPod", "podGone", "error"] as const;
export type ForwardStatus = (typeof FORWARD_STATUSES)[number];

/** A running port-forward (docs/ipc-contract.md#port-forward). */
export interface Forward {
  id: number;
  nodeId: NodeId;
  /** "Service web" */
  targetLabel: string;
  remotePort: number;
  localPort: number;
  /** The pod behind the latest connection. */
  pod: string | null;
  status: ForwardStatus;
  message: string | null;
}

export interface PortOption { port: number; label: string }
```

and among the guards:

```ts
export function isForward(v: unknown): v is Forward {
  return isObj(v) && typeof v.id === "number" && isStr(v.nodeId) && isStr(v.targetLabel) && typeof v.remotePort === "number"
    && typeof v.localPort === "number" && isStrOrNull(v.pod) && oneOf(FORWARD_STATUSES, v.status) && isStrOrNull(v.message);
}
export function isPortOption(v: unknown): v is PortOption {
  return isObj(v) && typeof v.port === "number" && isStr(v.label);
}
```

- [ ] **Step 3: Command wrappers**

In `src/shared/ipc/commands.ts` add `Forward, PortOption` to the type import and, after `stopLogs`:

```ts
  forwardPorts: (nodeId: NodeId) => call<PortOption[]>("forward_ports", { nodeId }),
  suggestLocalPort: (port: number) => call<number>("suggest_local_port", { port }),
  startForward: (nodeId: NodeId, remotePort: number, localPort: number) => call<Forward>("start_forward", { nodeId, remotePort, localPort }),
  stopForward: (id: number) => call<null>("stop_forward", { id }),
  openForward: (id: number) => call<null>("open_forward", { id }),
```

- [ ] **Step 4: Run the tests**

Run: `pnpm typecheck && pnpm test -- src/shared/ipc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc
git commit -m "$(cat <<'EOF'
Mirror port-forward types and commands in the frontend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 8: Store, event and Escape

**Files:**
- Modify: `src/app/store.ts`
- Modify: `src/shared/ipc/events.ts`
- Modify: `src/app/wireEvents.ts`
- Modify: `src/app/useGlobalKeys.ts`
- Create: `src/app/store.forwards.test.ts`
- Modify: `src/app/wireEvents.test.ts`, `src/app/useGlobalKeys.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/app/store.forwards.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));

import { invoke } from "../shared/ipc/tauri";
import type { Forward } from "../shared/ipc/types";
import { initialState, useAppStore } from "./store";

const WEB = "Service/p/web";
const fwd: Forward = { id: 1, nodeId: WEB, targetLabel: "Service web", remotePort: 80, localPort: 8080, pod: "web-1", status: "active", message: null };

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async () => null);
});

describe("port-forwards", () => {
  it("start adds the forward, closes its dialog and says so", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) => (cmd === "start_forward" ? fwd : null)) as typeof invoke);
    useAppStore.setState({ actionDialog: { type: "forward", nodeId: WEB } });
    const err = await useAppStore.getState().startForward(WEB, 80, 8080);
    expect(err).toBeNull();
    expect(invoke).toHaveBeenCalledWith("start_forward", { nodeId: WEB, remotePort: 80, localPort: 8080 });
    const s = useAppStore.getState();
    expect(s.forwards).toEqual([fwd]);
    expect(s.actionDialog).toBeNull();
    expect(s.toasts.at(-1)).toMatchObject({ kind: "info", message: "Forwarding localhost:8080 → Service web:80" });
  });

  it("a failed start returns the error and keeps the dialog", async () => {
    vi.mocked(invoke).mockImplementation((async () => { throw { kind: "conflict", message: "port 8080 is already in use" }; }) as typeof invoke);
    useAppStore.setState({ actionDialog: { type: "forward", nodeId: WEB } });
    const err = await useAppStore.getState().startForward(WEB, 80, 8080);
    expect(err).toEqual({ kind: "conflict", message: "port 8080 is already in use" });
    expect(useAppStore.getState().actionDialog).toEqual({ type: "forward", nodeId: WEB });
    expect(useAppStore.getState().forwards).toEqual([]);
  });

  it("an event that already listed the forward is not duplicated by the start result", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "start_forward") useAppStore.getState().setForwards([fwd]);
      return cmd === "start_forward" ? fwd : null;
    }) as typeof invoke);
    await useAppStore.getState().startForward(WEB, 80, 8080);
    expect(useAppStore.getState().forwards).toEqual([fwd]);
  });

  it("stop removes the forward; the popover closes when none is left", async () => {
    useAppStore.setState({ forwards: [fwd], forwardsOpen: true });
    await useAppStore.getState().stopForward(1);
    expect(invoke).toHaveBeenCalledWith("stop_forward", { id: 1 });
    expect(useAppStore.getState().forwards).toEqual([]);
    expect(useAppStore.getState().forwardsOpen).toBe(false);
  });

  it("open asks the backend to open the forward", async () => {
    await useAppStore.getState().openForward(1);
    expect(invoke).toHaveBeenCalledWith("open_forward", { id: 1 });
  });

  it("forwards survive a namespace switch", async () => {
    useAppStore.setState({ forwards: [fwd], connection: { ...initialState().connection, context: "c", state: "connected" } });
    await useAppStore.getState().selectNamespace("other");
    expect(useAppStore.getState().forwards).toEqual([fwd]);
  });
});
```

In `src/app/wireEvents.test.ts`, inside the first test before `stop();`, add:

```ts
    const fwd = { id: 1, nodeId: "Service/p/web", targetLabel: "Service web", remotePort: 80, localPort: 8080, pod: null, status: "noReadyPod" as const, message: null };
    hoisted.handlers!.forwards_changed([fwd]);
    expect(useAppStore.getState().forwards).toEqual([fwd]);
```

In `src/app/useGlobalKeys.test.tsx` (which renders `<App />` with mocked IPC and settings) add after the action-dialog Escape tests:

```tsx
  it("Escape closes the port-forward popover before touching the selection", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" }, selectedId: "Pod/p/a", select, forwardsOpen: true });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().forwardsOpen).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });
```

Run: `pnpm test -- src/app`
Expected: FAIL — `startForward`, `forwards`, `forwards_changed` do not exist (and typecheck errors).

- [ ] **Step 2: Store**

In `src/app/store.ts`:
- add `Forward` to the type import from `../shared/ipc/types`;
- `ActionDialog` gains a member:
  ```ts
    | { type: "forward"; nodeId: NodeId }
  ```
- `AppState` gains, after `requestedTab`:
  ```ts
    /** Running port-forwards, replaced by every `forwards_changed`. */
    forwards: Forward[];
    /** The header's port-forward popover. */
    forwardsOpen: boolean;
  ```
  and, after `toggleDetailsMaximized`:
  ```ts
    // port-forwards
    setForwards: (forwards: Forward[]) => void;
    setForwardsOpen: (open: boolean) => void;
    /** Start a forward; resolves to the error (shown in the dialog, not toasted) or null. */
    startForward: (nodeId: NodeId, remotePort: number, localPort: number) => Promise<AppError | null>;
    stopForward: (id: number) => Promise<void>;
    openForward: (id: number) => Promise<void>;
  ```
- `initialState()` gains `forwards: [], forwardsOpen: false,` (so `connect` and `disconnectedState` start with none — the backend dropped them with the old session; `selectNamespace` does not touch them);
- the actions, next to the workload actions:
  ```ts
    setForwards: (forwards) => set((s) => ({ forwards, forwardsOpen: forwards.length > 0 && s.forwardsOpen })),
    setForwardsOpen: (forwardsOpen) => set({ forwardsOpen }),
    startForward: async (nodeId, remotePort, localPort) => {
      try {
        const f = await commands.startForward(nodeId, remotePort, localPort);
        set((s) => ({
          // `forwards_changed` may have listed it already.
          forwards: s.forwards.some((x) => x.id === f.id) ? s.forwards : [...s.forwards, f],
          actionDialog: s.actionDialog?.type === "forward" && s.actionDialog.nodeId === nodeId ? null : s.actionDialog,
        }));
        get().toast({ kind: "info", message: `Forwarding localhost:${f.localPort} → ${f.targetLabel}:${f.remotePort}` });
        return null;
      } catch (e) {
        return toAppError(e);
      }
    },
    stopForward: async (id) => {
      try {
        await commands.stopForward(id);
        set((s) => {
          const forwards = s.forwards.filter((f) => f.id !== id);
          return { forwards, forwardsOpen: forwards.length > 0 && s.forwardsOpen };
        });
      } catch (e) {
        get().toast(toAppError(e));
      }
    },
    openForward: async (id) => {
      try {
        await commands.openForward(id);
      } catch (e) {
        get().toast(toAppError(e));
      }
    },
  ```

- [ ] **Step 3: Event, wiring, Escape**

`src/shared/ipc/events.ts`: import `Forward` and add `forwards_changed: Forward[];` to `BackendEvents`.

`src/app/wireEvents.ts`, in `listenAll({...})` after `object_events`:

```ts
    forwards_changed: (forwards) => s().setForwards(forwards),
```

`src/app/useGlobalKeys.ts`: add `|| s.forwardsOpen` to `modal`, and after the action-dialog line:

```ts
      if (s.forwardsOpen) { s.setForwardsOpen(false); return; }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (whole suite — `ActionDialogs` still narrows `dialog.type` correctly because the rollback branch is the last `return`; if TypeScript complains there, add an explicit `if (dialog.type === "forward") return null;` until Task 9 replaces it).

- [ ] **Step 5: Commit**

```bash
git add src/app src/shared/ipc/events.ts
git commit -m "$(cat <<'EOF'
Keep port-forwards in the store and follow forwards_changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 9: ForwardDialog

**Files:**
- Create: `src/features/forward/ForwardDialog.tsx`
- Create: `src/features/forward/ForwardDialog.test.tsx`
- Modify: `src/features/actions/ActionDialogs.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/features/forward/ForwardDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

import { initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import { ActionDialogs } from "../actions/ActionDialogs";

const SVC = "Service/p/web";
type Args = Record<string, unknown> | undefined;
let ports: { port: number; label: string }[] = [];

beforeEach(() => {
  useAppStore.setState(initialState());
  ports = [{ port: 80, label: "80 → http (web)" }, { port: 443, label: "443 → 443" }];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args: Args) => {
    if (cmd === "forward_ports") return ports;
    if (cmd === "suggest_local_port") return (args!.port as number) < 1024 ? 8080 : (args!.port as number);
    if (cmd === "start_forward") {
      if (args!.localPort === 9999) throw { kind: "conflict", message: "port 9999 is already in use" };
      return { id: 1, nodeId: args!.nodeId, targetLabel: "Service web", remotePort: args!.remotePort, localPort: args!.localPort, pod: "web-1", status: "active", message: null };
    }
    return null;
  }) as typeof invoke);
});

const open = (nodeId = SVC) => {
  useAppStore.setState({ actionDialog: { type: "forward", nodeId } });
  render(<ActionDialogs />);
};
const local = () => screen.getByLabelText("Local port") as HTMLInputElement;

describe("ForwardDialog", () => {
  it("offers the target's ports and prefills a free local port", async () => {
    open();
    expect(screen.getByRole("heading", { name: "Port-forward Service web" })).toBeInTheDocument();
    await waitFor(() => expect(local().value).toBe("8080"));
    const remote = screen.getByLabelText("Remote port") as HTMLSelectElement;
    expect([...remote.options].map((o) => o.textContent)).toEqual(["80 → http (web)", "443 → 443"]);
    fireEvent.change(remote, { target: { value: "443" } });
    await waitFor(() => expect(local().value).toBe("8080")); // 443 < 1024 → 8080 again
  });

  it("Start forwards and closes the dialog", async () => {
    open();
    await waitFor(() => expect(local().value).toBe("8080"));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(useAppStore.getState().actionDialog).toBeNull());
    expect(invoke).toHaveBeenCalledWith("start_forward", { nodeId: SVC, remotePort: 80, localPort: 8080 });
  });

  it("a port in use is shown in the dialog, which stays open", async () => {
    open();
    await waitFor(() => expect(local().value).toBe("8080"));
    fireEvent.change(local(), { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("port 9999 is already in use");
    expect(useAppStore.getState().actionDialog).toEqual({ type: "forward", nodeId: SVC });
  });

  it("privileged or out-of-range local ports cannot be started", async () => {
    open();
    await waitFor(() => expect(local().value).toBe("8080"));
    for (const v of ["80", "70000", ""]) {
      fireEvent.change(local(), { target: { value: v } });
      expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    }
  });

  it("a workload without declared ports takes a remote port by hand", async () => {
    ports = [];
    open("Deployment/p/api");
    const remote = (await screen.findByLabelText("Remote port")) as HTMLInputElement;
    expect(remote.tagName).toBe("INPUT");
    fireEvent.change(remote, { target: { value: "3000" } });
    await waitFor(() => expect(local().value).toBe("3000"));
  });

  it("a Service without TCP ports says so", async () => {
    ports = [];
    open();
    expect(await screen.findByText("This Service has no TCP ports.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("Cancel closes without forwarding", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().actionDialog).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("start_forward", expect.anything());
  });
});
```

Run: `pnpm test -- src/features/forward`
Expected: FAIL — `ActionDialogs` does not render a forward dialog.

- [ ] **Step 2: Implement the dialog**

Create `src/features/forward/ForwardDialog.tsx`:

```tsx
import { useEffect, useId, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type NodeId, type PortOption } from "../../shared/ipc/types";
import { Button } from "../../shared/ui/Button";
import { describeId, kindOf } from "../actions/actionKinds";

const inRange = (n: number, min: number) => Number.isInteger(n) && n >= min && n <= 65535;
const field = "rounded-xl border border-border-strong bg-transparent px-3 py-1.5 text-text-hi outline-none focus-visible:ring-1 focus-visible:ring-accent";

/** Pick a remote port of `nodeId` and a local one, then start forwarding. Escape closes it from `useGlobalKeys`. */
export function ForwardDialog({ nodeId }: { nodeId: NodeId }) {
  const { close, startForward } = useAppStore(useShallow((s) => ({ close: s.closeActionDialog, startForward: s.startForward })));
  const [ports, setPorts] = useState<PortOption[] | null>(null);
  const [remote, setRemote] = useState("");
  const [local, setLocal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const isService = kindOf(nodeId) === "Service";

  useEffect(() => {
    let active = true;
    commands.forwardPorts(nodeId).then(
      (p) => { if (!active) return; setPorts(p); if (p[0]) setRemote(String(p[0].port)); },
      (e) => { if (!active) return; setPorts([]); setError(toAppError(e).message); },
    );
    return () => { active = false; };
  }, [nodeId]);

  // A new remote port brings a fresh suggestion; the user can still type over it.
  const remotePort = Number(remote);
  useEffect(() => {
    if (!inRange(remotePort, 1)) return;
    let active = true;
    commands.suggestLocalPort(remotePort).then((p) => { if (active) setLocal(String(p)); }, () => {});
    return () => { active = false; };
  }, [remotePort]);

  const localPort = Number(local);
  const valid = inRange(remotePort, 1) && local.trim() !== "" && inRange(localPort, 1024);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const err = await startForward(nodeId, remotePort, localPort);
    setBusy(false);
    if (err) setError(err.message);
  };

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80">
      <form role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={(e) => void submit(e)}
        className="w-[440px] rounded-card border border-border bg-elevated p-8">
        <h2 id={titleId} className="mb-4 text-2xl font-semibold leading-[1.33] text-text-hi">Port-forward {describeId(nodeId)}</h2>
        {ports === null ? (
          <p className="mb-6 text-sm text-text-muted">Loading ports…</p>
        ) : ports.length === 0 && isService ? (
          <p className="mb-6 text-sm text-text-muted">This Service has no TCP ports.</p>
        ) : (
          <div className="mb-6 grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-3 text-sm text-text-dim">
            <label htmlFor={`${titleId}-remote`}>Remote port</label>
            {ports.length > 0 ? (
              <select id={`${titleId}-remote`} aria-label="Remote port" value={remote} onChange={(e) => setRemote(e.target.value)} className={field}>
                {ports.map((p) => <option key={p.port} value={p.port}>{p.label}</option>)}
              </select>
            ) : (
              <input id={`${titleId}-remote`} aria-label="Remote port" type="number" min={1} max={65535} value={remote}
                onChange={(e) => setRemote(e.target.value)} placeholder="container port" className={`w-32 ${field}`} />
            )}
            <label htmlFor={`${titleId}-local`}>Local port</label>
            <input id={`${titleId}-local`} aria-label="Local port" type="number" min={1024} max={65535} value={local}
              onChange={(e) => setLocal(e.target.value)} className={`w-32 tabular-nums ${field}`} />
          </div>
        )}
        {error && <p role="alert" className="mb-4 break-words text-sm text-status-err">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>Start</Button>
        </div>
      </form>
    </div>
  );
}
```

In `src/features/actions/ActionDialogs.tsx` import it (`import { ForwardDialog } from "../forward/ForwardDialog";`) and route it before the rollback fallback (replace any temporary `return null` from Task 8):

```tsx
  if (dialog.type === "forward") return <ForwardDialog nodeId={dialog.nodeId} />;
```

- [ ] **Step 3: Run the tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/forward src/features/actions/ActionDialogs.tsx
git commit -m "$(cat <<'EOF'
Add the Port-forward dialog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 10: ForwardsIndicator in the header

**Files:**
- Create: `src/features/forward/ForwardsIndicator.tsx`
- Create: `src/features/forward/ForwardsIndicator.test.tsx`
- Modify: `src/features/cluster/Header.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/features/forward/ForwardsIndicator.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

import { initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import type { Forward } from "../../shared/ipc/types";
import { ForwardsIndicator } from "./ForwardsIndicator";

const a: Forward = { id: 1, nodeId: "Service/p/web", targetLabel: "Service web", remotePort: 80, localPort: 8080, pod: "web-1", status: "active", message: null };
const b: Forward = { id: 2, nodeId: "Pod/p/db-0", targetLabel: "Pod db-0", remotePort: 5432, localPort: 5432, pod: null, status: "error", message: "forbidden" };
const writeText = vi.fn(async () => {});

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockClear();
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

describe("ForwardsIndicator", () => {
  it("is hidden without forwards", () => {
    render(<ForwardsIndicator />);
    expect(screen.queryByRole("button", { name: "Port forwards" })).not.toBeInTheDocument();
  });

  it("counts the forwards and lists them with their status", () => {
    useAppStore.setState({ forwards: [a, b] });
    render(<ForwardsIndicator />);
    const button = screen.getByRole("button", { name: "Port forwards" });
    expect(button).toHaveTextContent("2");
    fireEvent.click(button);
    expect(useAppStore.getState().forwardsOpen).toBe(true);
    expect(screen.getByText("localhost:8080")).toBeInTheDocument();
    expect(screen.getByText("active · web-1")).toBeInTheDocument();
    expect(screen.getByText("error: forbidden")).toBeInTheDocument();
  });

  it("Open, Copy and Stop act on their forward", () => {
    useAppStore.setState({ forwards: [a], forwardsOpen: true });
    render(<ForwardsIndicator />);
    fireEvent.click(screen.getByRole("button", { name: "Open localhost:8080" }));
    expect(invoke).toHaveBeenCalledWith("open_forward", { id: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Copy localhost:8080" }));
    expect(writeText).toHaveBeenCalledWith("http://localhost:8080");
    fireEvent.click(screen.getByRole("button", { name: "Stop localhost:8080" }));
    expect(invoke).toHaveBeenCalledWith("stop_forward", { id: 1 });
  });

  it("a click outside closes the popover", () => {
    useAppStore.setState({ forwards: [a], forwardsOpen: true });
    render(<ForwardsIndicator />);
    fireEvent.mouseDown(screen.getByTestId("forwards-backdrop"));
    expect(useAppStore.getState().forwardsOpen).toBe(false);
  });
});
```

Run: `pnpm test -- src/features/forward/ForwardsIndicator`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

Create `src/features/forward/ForwardsIndicator.tsx`:

```tsx
import { ArrowLeftRight } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { Forward, ForwardStatus, Status } from "../../shared/ipc/types";
import { Dot } from "../../shared/ui/Dot";

const TEXT: Record<ForwardStatus, string> = { active: "active", noReadyPod: "no ready pod", podGone: "pod gone", error: "error" };
const DOT: Record<ForwardStatus, Status> = { active: "ok", noReadyPod: "warn", podGone: "err", error: "err" };
const action = "rounded-lg px-2 py-0.5 hover:bg-muted hover:text-text-hi";

function detail(f: Forward): string {
  if (f.status === "error") return `error: ${f.message ?? "unknown"}`;
  return f.pod ? `${TEXT[f.status]} · ${f.pod}` : TEXT[f.status];
}

/** `⇄ N` in the header; its popover lists the forwards with Open / Copy / Stop. Escape closes it via `useGlobalKeys`. */
export function ForwardsIndicator() {
  const { forwards, open, setOpen, stop, openUrl } = useAppStore(useShallow((s) => ({
    forwards: s.forwards, open: s.forwardsOpen, setOpen: s.setForwardsOpen, stop: s.stopForward, openUrl: s.openForward,
  })));
  if (forwards.length === 0) return null;
  return (
    <div className="no-drag relative">
      <button type="button" aria-label="Port forwards" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-text-hi hover:bg-muted">
        <ArrowLeftRight className="size-4" /> {forwards.length}
      </button>
      {open && (
        <>
          <div data-testid="forwards-backdrop" className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
          <div role="dialog" aria-label="Port forwards" className="absolute right-0 top-11 z-40 w-[26rem] rounded-card border border-border bg-elevated p-2 text-sm">
            <ul className="space-y-1">
              {forwards.map((f) => {
                const addr = `localhost:${f.localPort}`;
                return (
                  <li key={f.id} className="rounded-lg px-3 py-2 hover:bg-surface">
                    <div className="flex items-center gap-2">
                      <Dot status={DOT[f.status]} />
                      <span className="font-mono text-text-hi">{addr}</span>
                      <span className="min-w-0 truncate text-text-muted">→ {f.targetLabel} :{f.remotePort}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-xs text-text-muted">
                      <span className="min-w-0 flex-1 truncate">{detail(f)}</span>
                      <button type="button" aria-label={`Open ${addr}`} className={action} onClick={() => void openUrl(f.id)}>Open</button>
                      <button type="button" aria-label={`Copy ${addr}`} className={action} onClick={() => void navigator.clipboard.writeText(`http://${addr}`)}>Copy</button>
                      <button type="button" aria-label={`Stop ${addr}`} className={`${action} text-status-err`} onClick={() => void stop(f.id)}>Stop</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
```

In `src/features/cluster/Header.tsx` import it (`import { ForwardsIndicator } from "../forward/ForwardsIndicator";`) and render it right after the search `<div className="no-drag relative ml-auto">…</div>`, before the connection `<Dot …/>`:

```tsx
      <ForwardsIndicator />
```

- [ ] **Step 3: Run the tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (the header tests are unaffected: the indicator renders nothing without forwards).

- [ ] **Step 4: Commit**

```bash
git add src/features/forward src/features/cluster/Header.tsx
git commit -m "$(cat <<'EOF'
Show running port-forwards in the header

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 11: Port-forward… in the Actions menu

**Files:**
- Modify: `src/features/actions/actionKinds.ts`, `src/features/actions/actionKinds.test.ts`
- Modify: `src/features/actions/ActionsMenu.tsx`, `src/features/actions/ActionsMenu.test.tsx`
- Modify: `src/features/details/DetailsPanel.test.tsx`

- [ ] **Step 1: Update the tests first**

`src/features/actions/actionKinds.test.ts` — the `actionsFor` expectations become:

```ts
    expect(actionsFor("Deployment")).toEqual(["scale", "restart", "rollback", "forward", "delete"]);
    expect(actionsFor("StatefulSet")).toEqual(["scale", "restart", "rollback", "forward", "delete"]);
    expect(actionsFor("DaemonSet")).toEqual(["restart", "rollback", "forward", "delete"]);
    expect(actionsFor("Pod")).toEqual(["forward", "delete"]);
    expect(actionsFor("Service")).toEqual(["forward", "delete"]);
    expect(actionsFor("PodGroup")).toEqual(["delete"]);
    expect(actionsFor(null)).toEqual(["delete"]);
```

`src/features/actions/ActionsMenu.test.tsx`:
- in "lists the actions for the kind and focuses the first", the list becomes `["Scale…", "Restart", "Rollback…", "Port-forward…", "Delete…"]`, and the two `ArrowUp` presses from `Restart` still land on `Delete…` (wrap: Restart → Scale… → Delete…);
- add:

```tsx
  it("Port-forward… opens the forward dialog", () => {
    open("Service/p/web");
    render(<ActionsMenu />);
    expect(items()).toEqual(["Port-forward…", "Delete…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Port-forward…" }));
    expect(useAppStore.getState().actionDialog).toEqual({ type: "forward", nodeId: "Service/p/web" });
    expect(useAppStore.getState().actionsMenu).toBeNull();
  });
```

`src/features/details/DetailsPanel.test.tsx` — "has no Actions button when delete is the only action" used the default Pod node, which now has Port-forward…; switch it to a ConfigMap:

```tsx
  it("has no Actions button when delete is the only action (the trash button covers it)", () => {
    const cm = { ...node, id: "ConfigMap/p/cfg", kind: "ConfigMap" as const, name: "cfg" };
    useAppStore.setState((s) => ({ nodes: new Map([...s.nodes, [cm.id, cm]]), selectedId: cm.id, details: { ...s.details!, nodeId: cm.id } }));
    render(<DetailsPanel />);
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
```

Run: `pnpm test -- src/features/actions src/features/details`
Expected: FAIL — no `forward` action yet.

- [ ] **Step 2: Implement**

`src/features/actions/actionKinds.ts`:

```ts
export const FORWARD_KINDS: ReadonlySet<Kind> = new Set<Kind>(["Pod", "Service", "Deployment", "StatefulSet", "DaemonSet"]);

export type ActionId = "scale" | "restart" | "rollback" | "forward" | "delete";

/** The Actions menu items for a kind, in menu order; everything can be deleted. */
export function actionsFor(kind: Kind | null): ActionId[] {
  const out: ActionId[] = [];
  if (kind && SCALE_KINDS.has(kind)) out.push("scale");
  if (kind && ROLLOUT_KINDS.has(kind)) out.push("restart", "rollback");
  if (kind && FORWARD_KINDS.has(kind)) out.push("forward");
  out.push("delete");
  return out;
}
```

`src/features/actions/ActionsMenu.tsx`:
- `LABEL` gains `forward: "Port-forward…"`;
- `run` becomes:
  ```ts
    const run = (id: ActionId) => {
      close();
      if (id === "scale" || id === "restart" || id === "forward") openActionDialog({ type: id, nodeId: menu.nodeId });
      else if (id === "rollback") requestTab("history");
      else requestDelete(menu.nodeId);
    };
  ```

- [ ] **Step 3: Run the tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/features/actions src/features/details/DetailsPanel.test.tsx
git commit -m "$(cat <<'EOF'
Offer Port-forward… in the Actions menu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 12: README, full checks, live check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document**

In `README.md`, after the **Rollout actions.** block, add:

```markdown
**Port-forward.** **Port-forward…** in the Actions menu (Pods, Services, Deployments, StatefulSets, DaemonSets) forwards a local port on `127.0.0.1` to the object. Pick one of its ports; the local port defaults to the same number when it is free. A Service or workload forward follows ready pods, so it keeps working through restarts and rollouts. The **⇄** button in the header lists the running forwards, with **Open** (in the browser), **Copy** and **Stop**. Forwards stop when you switch cluster or disconnect.
```

- [ ] **Step 2: Every check CI runs, plus the smoke test**

```bash
rtk proxy pnpm typecheck
rtk proxy pnpm test
cd src-tauri
rtk proxy cargo fmt --check
rtk proxy cargo clippy --all-targets -- -D warnings
rtk proxy cargo test
WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored
```

Expected: all green (smoke only against the local `docker-desktop` context).

- [ ] **Step 3: Live check**

`pnpm tauri build --debug --bundles app`, open the app, namespace `shop`:
1. Right-click the `web` Service → **Port-forward…** → port `80 → …`, local 8080 (or the next free) → **Start**: toast, header shows `⇄ 1`.
2. **Open** in the popover opens nginx in the browser; **Copy** copies the address.
3. Delete one `web` pod: a reload still works; the popover's pod name changes.
4. **Stop**: the indicator disappears; the browser can no longer connect.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Document port-forwarding in the README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

## Deviations from the spec

1. **Pods are resolved with live API reads, not from the cached store.** The store holds only the selected namespace and is replaced on every `select_namespace`, while forwards outlive namespace switches; `KubeConnector` therefore does `get`/`list` per connection. The dialog's `forward_ports` still reads the store (the target is in the shown namespace).
2. **Workload pods come from the workload's label selector** (`spec.selector.matchLabels`), like `kubectl port-forward deploy/x`, not from `is_owned_by`; `resolve` is split into pure helpers (`pick_pod`, `serving`, `service_target_port`, `selector_string`) plus the live connector.
3. **No `list_forwards` command.** Every connection starts without forwards (the old session dropped them), so the list is fully driven by `forwards_changed` and `start_forward`'s result.
4. **Open goes through a Rust command `open_forward { id }`** using tauri-plugin-opener's Rust API, so no `@tauri-apps/plugin-opener` package and no frontend capability are needed, and the webview cannot open arbitrary URLs.
5. **Status changes on connection attempts** (and on the initial resolve at start), not on store changes — the manager does not watch the cluster between connections.
6. **Pods and workloads without declared container ports** get a number input for the remote port instead of an empty list; a Service without TCP ports says so.
7. **The manager is tested through a `Connector` trait with an in-memory echo**, not a fake kube server.
8. **`pod_ready` becomes `pub(crate)`** in `graph/status.rs` so serving pods follow the same readiness rule as the graph.
9. **The forward dialog is a new `ActionDialog` type (`forward`)**, so the existing Escape/close/namespace-reset handling of action dialogs covers it.
