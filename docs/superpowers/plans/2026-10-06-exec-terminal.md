# Container Terminal (exec) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Terminal** tab in the details panel that opens an interactive shell (`bash` if present, else `sh`) in a running container of a Pod or workload.

**Architecture:** A new backend module `src-tauri/src/exec/` mirrors the Logs feature: a session per terminal, owned by the namespace session (stopped on namespace switch / disconnect), messages pushed through a Tauri `Channel`. `start_exec` validates the pod/container against the cached store and returns at once; the session task opens the websocket (`Api::<Pod>::exec` with a TTY), pumps stdout → base64 `output` messages, and stdin/resize from an input queue. The frontend loads xterm.js lazily (dynamic import) into `TerminalTab`, bridges it with `useExecSession`, and keeps app shortcuts out by stopping keydown propagation at the terminal element.

**Tech Stack:** Rust (kube 4.2 `ws` feature: `Api::exec`, `AttachParams`, `AttachedProcess`, `TerminalSize`; tokio; base64 0.22), Tauri 2 `ipc::Channel`, React 19 + zustand, `@xterm/xterm` 5 + `@xterm/addon-fit`, Vitest + Testing Library.

Spec: `docs/superpowers/specs/2026-10-06-exec-terminal-design.md`.

---

## File map

| File | Responsibility |
|---|---|
| `src-tauri/Cargo.toml` | add `base64 = "0.22"` |
| `src-tauri/src/lib.rs` | `pub mod exec;` |
| `src-tauri/src/exec/mod.rs` (new) | `ExecPod`, `ExecMessage`, `ExecSink`, `ClosableExecSink`, `SHELL`, base64 + size helpers |
| `src-tauri/src/exec/targets.rs` (new) | `exec_pods`, `check_target` — pure, on the `Store` |
| `src-tauri/src/exec/errors.rs` (new) | connect-error and exit-status mapping — pure |
| `src-tauri/src/exec/session.rs` (new) | `ExecSessions`, `Process`, `ExecConnector`, the session task/pump |
| `src-tauri/src/exec/remote.rs` (new) | `KubeExec`: the real connector (`Api::<Pod>::exec`) |
| `src-tauri/tests/fixtures/exec.yaml` (new) | pods for target tests |
| `src-tauri/src/session/mod.rs` | own `ExecSessions`; methods; stop with the watchers |
| `src-tauri/src/commands.rs` | `exec_pods`, `start_exec`, `exec_input`, `exec_resize`, `stop_exec` |
| `src-tauri/tests/ipc_fixtures.rs`, `src/shared/ipc/fixtures/exec_message.json`, `exec_pod.json` (new) | contract fixtures |
| `docs/ipc-contract.md` | "Exec" section + command rows |
| `src-tauri/tests/smoke.rs` | `exercise_exec` |
| `package.json` | `@xterm/xterm`, `@xterm/addon-fit` |
| `src/shared/ipc/types.ts`, `commands.ts`, `fixtures.test.ts` | types, guards, wrappers |
| `src/features/exec/base64.ts` (+test) | text → base64, base64 → bytes |
| `src/features/exec/terminal.ts` | lazy xterm wrapper (`createTerminal`) |
| `src/features/exec/useExecSession.ts` (+test) | start/stop/input/resize bridge |
| `src/features/exec/TerminalTab.tsx` (+test) | toolbar + terminal view |
| `src/app/store.ts`, `src/features/details/DetailsPanel.tsx` (+test) | `"terminal"` tab |
| `README.md` | feature paragraph |

---

### Task 1: Exec types, sink and base64 helpers

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`
- Create: `src-tauri/src/exec/mod.rs`

- [ ] **Step 1: Add the dependency and the module**

In `src-tauri/Cargo.toml` `[dependencies]` add (next to `futures`):

```toml
base64 = "0.22"
```

In `src-tauri/src/lib.rs` add `pub mod exec;` next to `pub mod forward;` (keep alphabetical order of the existing `pub mod` lines).

- [ ] **Step 2: Write the failing tests** — create `src-tauri/src/exec/mod.rs` with only the test module first:

```rust
//! Interactive shell into a container (spec: docs/superpowers/specs/2026-10-06-exec-terminal-design.md).

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn messages_are_tagged_camel_case() {
        let v = serde_json::to_value(ExecMessage::Output { session_id: 2, data: "aGkK".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "type": "output", "sessionId": 2, "data": "aGkK" }));
        let v = serde_json::to_value(ExecMessage::Ended { session_id: 2, code: Some(3), message: None }).unwrap();
        assert_eq!(v, serde_json::json!({ "type": "ended", "sessionId": 2, "code": 3, "message": null }));
        let v = serde_json::to_value(ExecMessage::Error { session_id: 2, message: "m".into() }).unwrap();
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
        let msg = ExecMessage::Error { session_id: 1, message: "x".into() };
        sink.send(msg.clone());
        assert_eq!(rx.try_recv().unwrap(), msg);
        sink.close();
        sink.send(msg);
        assert!(rx.try_recv().is_err());
    }
}
```

- [ ] **Step 2b: Run it to see it fail**

Run: `cd src-tauri && cargo test --lib exec::tests`
Expected: compile errors — `ExecMessage`, `encode_output`, `decode_input`, `clamp_size`, `ClosableExecSink` not found.

- [ ] **Step 3: Implement** — put this above the test module in `src-tauri/src/exec/mod.rs`:

```rust
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
    Output { session_id: u32, data: String },
    Ended { session_id: u32, code: Option<i32>, message: Option<String> },
    Error { session_id: u32, message: String },
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
        Self { inner, closed: AtomicBool::new(false) }
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
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib exec::tests && cargo clippy --all-targets -- -D warnings`
Expected: 4 passed; clippy clean (the items are `pub`, so no dead-code warnings).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/exec/mod.rs
git commit -m "$(cat <<'EOF'
Add exec message types, a closable sink and base64 framing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 2: Which pods and containers a terminal can open in

**Files:**
- Create: `src-tauri/tests/fixtures/exec.yaml`, `src-tauri/src/exec/targets.rs`
- Modify: `src-tauri/src/exec/mod.rs` (`pub mod targets;`)

- [ ] **Step 1: Fixture** — `src-tauri/tests/fixtures/exec.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: shop, uid: dep-web }
spec:
  replicas: 4
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [ { name: app, image: nginx } ] }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-7f9c
  namespace: shop
  uid: rs-web
  ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: web, uid: dep-web, controller: true } ]
spec:
  replicas: 4
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [ { name: app, image: nginx } ] }
---
apiVersion: v1
kind: Pod
metadata:
  name: web-7f9c-b
  namespace: shop
  uid: pod-web-b
  labels: { app: web }
  ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: web-7f9c, uid: rs-web, controller: true } ]
spec:
  initContainers: [ { name: migrate, image: busybox } ]
  containers: [ { name: app, image: nginx }, { name: sidecar, image: envoy } ]
status: { phase: Running }
---
apiVersion: v1
kind: Pod
metadata:
  name: web-7f9c-a
  namespace: shop
  uid: pod-web-a
  labels: { app: web }
  ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: web-7f9c, uid: rs-web, controller: true } ]
spec:
  initContainers: [ { name: migrate, image: busybox } ]
  containers: [ { name: app, image: nginx }, { name: sidecar, image: envoy } ]
status: { phase: Running }
---
apiVersion: v1
kind: Pod
metadata:
  name: web-7f9c-c
  namespace: shop
  uid: pod-web-c
  labels: { app: web }
  ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: web-7f9c, uid: rs-web, controller: true } ]
spec: { containers: [ { name: app, image: nginx } ] }
status: { phase: Pending }
---
apiVersion: v1
kind: Pod
metadata:
  name: web-7f9c-d
  namespace: shop
  uid: pod-web-d
  labels: { app: web }
  deletionTimestamp: "2026-10-06T10:00:00Z"
  ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: web-7f9c, uid: rs-web, controller: true } ]
spec: { containers: [ { name: app, image: nginx } ] }
status: { phase: Running }
---
apiVersion: v1
kind: Pod
metadata: { name: solo, namespace: shop, uid: pod-solo }
spec: { containers: [ { name: main, image: busybox } ] }
status: { phase: Running }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: cfg, namespace: shop }
data: { k: v }
```

- [ ] **Step 2: Failing tests** — `src-tauri/src/exec/targets.rs` with the test module first, and `pub mod targets;` in `exec/mod.rs`:

```rust
//! Which running pods and containers a node id offers a terminal for (spec §3 "Open").
//! Pure: reads only the in-memory `Store`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    fn store() -> Store {
        Store::from_fixture("exec").unwrap()
    }

    fn names(pods: &[ExecPod]) -> Vec<&str> {
        pods.iter().map(|p| p.name.as_str()).collect()
    }

    #[test]
    fn a_workload_offers_its_running_pods_in_name_order_without_init_containers() {
        let pods = exec_pods(&store(), "Deployment/shop/web").unwrap();
        assert_eq!(names(&pods), vec!["web-7f9c-a", "web-7f9c-b"], "pending and terminating pods are left out");
        assert_eq!(pods[0].containers, vec!["app", "sidecar"]);
    }

    #[test]
    fn a_pod_offers_itself_when_running() {
        let pods = exec_pods(&store(), "Pod/shop/solo").unwrap();
        assert_eq!(pods, vec![ExecPod { name: "solo".into(), containers: vec!["main".into()] }]);
        assert!(exec_pods(&store(), "Pod/shop/web-7f9c-c").unwrap().is_empty(), "a Pending pod offers nothing");
    }

    #[test]
    fn unknown_pods_and_kinds_without_containers_are_rejected() {
        assert_eq!(exec_pods(&store(), "Pod/shop/ghost").unwrap_err().kind, ErrorKind::NotFound);
        assert_eq!(exec_pods(&store(), "ConfigMap/shop/cfg").unwrap_err().kind, ErrorKind::Invalid);
    }

    #[test]
    fn a_start_request_must_name_an_offered_pod_and_container() {
        let s = store();
        assert_eq!(check_target(&s, "Deployment/shop/web", "web-7f9c-b", "sidecar").unwrap(), "shop");
        assert_eq!(check_target(&s, "Deployment/shop/web", "solo", "main").unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(check_target(&s, "Deployment/shop/web", "web-7f9c-c", "app").unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(check_target(&s, "Deployment/shop/web", "web-7f9c-a", "migrate").unwrap_err().kind, ErrorKind::NotFound);
        assert_eq!(check_target(&s, "Deployment/shop/web", "web-7f9c-a", "nope").unwrap_err().kind, ErrorKind::NotFound);
    }
}
```

Run: `cd src-tauri && cargo test --lib exec::targets`
Expected: compile errors (`exec_pods`, `check_target` missing).

- [ ] **Step 3: Implement** — above the tests in `targets.rs`:

```rust
use k8s_openapi::api::core::v1::Pod;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::build::{group_members, is_owned_by, OWNER_CHAIN_DEPTH};
use crate::session::parse_node_id;
use crate::store::{Kind, Object, Store};

use super::ExecPod;

/// A pod that can run `exec`: Running and not being deleted.
fn running(p: &Pod) -> bool {
    p.metadata.deletion_timestamp.is_none() && p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running")
}

/// The running pods `node_id` stands for, in pod-name order, each with its regular containers.
/// Kinds that run no pods are `invalid`; a Pod that is not in the store is `notFound`.
pub fn exec_pods(store: &Store, node_id: &str) -> AppResult<Vec<ExecPod>> {
    let (kind, ns, name) = parse_node_id(node_id)?;
    let objects: Vec<&Object> = match kind {
        Kind::Pod => vec![store
            .find(Kind::Pod, ns.as_deref(), &name)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in store")))?],
        Kind::PodGroup => group_members(store, node_id).iter().filter_map(|key| store.get(key)).collect(),
        Kind::Deployment | Kind::StatefulSet | Kind::DaemonSet | Kind::Job => store
            .iter_kind(Kind::Pod)
            .filter(|pod| pod.namespace() == ns.as_deref())
            .filter(|pod| is_owned_by(store, pod, kind, &name, OWNER_CHAIN_DEPTH))
            .collect(),
        other => {
            return Err(AppError::new(
                ErrorKind::Invalid,
                format!("{} has no containers to open a terminal in", other.as_str()),
            ))
        }
    };
    let mut pods: Vec<ExecPod> = objects
        .into_iter()
        .filter_map(|obj| {
            let Object::Pod(p) = obj else { return None };
            if !running(p) {
                return None;
            }
            let containers: Vec<String> = p.spec.as_ref()?.containers.iter().map(|c| c.name.clone()).collect();
            (!containers.is_empty()).then(|| ExecPod { name: obj.name().to_string(), containers })
        })
        .collect();
    pods.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(pods)
}

/// Check a start request against what `exec_pods` offers; returns the namespace to exec in.
pub fn check_target(store: &Store, node_id: &str, pod: &str, container: &str) -> AppResult<String> {
    let (_, ns, _) = parse_node_id(node_id)?;
    let pods = exec_pods(store, node_id)?;
    let Some(found) = pods.iter().find(|p| p.name == pod) else {
        return Err(AppError::new(
            ErrorKind::Invalid,
            format!("pod {pod} is not running or does not belong to {node_id}"),
        ));
    };
    if !found.containers.iter().any(|c| c == container) {
        return Err(AppError::new(ErrorKind::NotFound, format!("pod {pod} has no container \"{container}\"")));
    }
    ns.ok_or_else(|| AppError::new(ErrorKind::Invalid, format!("{node_id} has no namespace")))
}
```

(`is_owned_by` is `pub(crate)` and `OWNER_CHAIN_DEPTH` is used the same way by `logs/targets.rs`; if either is not visible from `exec`, widen it to `pub(crate)` — nothing else.)

- [ ] **Step 4: Run** — `cd src-tauri && cargo test --lib exec::targets && cargo clippy --all-targets -- -D warnings` → 4 passed, clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests/fixtures/exec.yaml src-tauri/src/exec/targets.rs src-tauri/src/exec/mod.rs
git commit -m "$(cat <<'EOF'
List the running pods and containers a terminal can open in

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 3: Connect errors and exit status

**Files:**
- Create: `src-tauri/src/exec/errors.rs`
- Modify: `src-tauri/src/exec/mod.rs` (`pub mod errors;`)

- [ ] **Step 1: Failing tests** — `errors.rs`, tests first:

```rust
//! What a failed or finished exec means to the user (spec §3 "Errors", §4 exit code). Pure.

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};

    fn failure(message: &str, exit: Option<&str>) -> Status {
        Status {
            status: Some("Failure".into()),
            message: Some(message.into()),
            reason: Some("NonZeroExitCode".into()),
            details: exit.map(|code| StatusDetails {
                causes: Some(vec![StatusCause { reason: Some("ExitCode".into()), message: Some(code.into()), field: None }]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn a_forbidden_upgrade_names_the_missing_permission() {
        let e = kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(http::StatusCode::FORBIDDEN));
        assert_eq!(start_error(&e), FORBIDDEN);
        let api = kube::Error::Api(Box::new(kube::core::Status::failure("no", "Forbidden").with_code(403)));
        assert_eq!(start_error(&api), FORBIDDEN);
        let other = kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(http::StatusCode::BAD_GATEWAY));
        assert!(start_error(&other).contains("502"));
    }

    #[test]
    fn success_is_exit_code_zero() {
        let ok = Status { status: Some("Success".into()), ..Default::default() };
        assert_eq!(ended(Some(&ok)), (Some(0), None));
        assert_eq!(ended(None), (None, None));
    }

    #[test]
    fn a_non_zero_exit_reports_only_the_code() {
        assert_eq!(ended(Some(&failure("command terminated with non-zero exit code: 3", Some("3")))), (Some(3), None));
    }

    #[test]
    fn a_missing_shell_says_so() {
        let s = failure(r#"exec: "sh": executable file not found in $PATH: unknown"#, None);
        assert_eq!(ended(Some(&s)), (None, Some(NO_SHELL.to_string())));
        assert!(is_no_shell(r#"OCI runtime exec failed: exec: "sh": executable file not found in $PATH"#));
    }

    #[test]
    fn other_failures_keep_the_server_message() {
        let s = failure("container not running", None);
        assert_eq!(ended(Some(&s)), (None, Some("container not running".to_string())));
    }
}
```

Run: `cd src-tauri && cargo test --lib exec::errors` → compile errors.

- [ ] **Step 2: Implement** — above the tests:

```rust
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;

use crate::error::AppError;

pub const FORBIDDEN: &str = "No permission to exec into pods (pods/exec)";
pub const NO_SHELL: &str = "This container has no shell (distroless image?)";

pub fn is_no_shell(message: &str) -> bool {
    message.contains("executable file not found")
}

/// The message for a websocket that could not be opened. A refused upgrade surfaces as
/// `ProtocolSwitch(status)`, not as an API error (same as `forward::kube`).
pub fn start_error(e: &kube::Error) -> String {
    use kube::client::UpgradeConnectionError::ProtocolSwitch;
    match e {
        kube::Error::UpgradeConnection(ProtocolSwitch(status)) if *status == http::StatusCode::FORBIDDEN => FORBIDDEN.into(),
        kube::Error::UpgradeConnection(ProtocolSwitch(status)) => format!("exec refused: {status}"),
        kube::Error::Api(resp) if resp.code == 403 => FORBIDDEN.into(),
        _ => {
            let message = AppError::from(e).message;
            if is_no_shell(&message) {
                NO_SHELL.into()
            } else {
                message
            }
        }
    }
}

fn exit_code(s: &Status) -> Option<i32> {
    s.details
        .as_ref()?
        .causes
        .as_ref()?
        .iter()
        .find(|c| c.reason.as_deref() == Some("ExitCode"))?
        .message
        .as_ref()?
        .parse()
        .ok()
}

/// `(exit code, message)` for the `ended` message from the status channel. A plain non-zero
/// exit carries only its code; a missing shell gets `NO_SHELL`; anything else keeps the
/// server's message.
pub fn ended(status: Option<&Status>) -> (Option<i32>, Option<String>) {
    let Some(s) = status else { return (None, None) };
    if s.status.as_deref() == Some("Success") {
        return (Some(0), None);
    }
    let message = s.message.clone().unwrap_or_default();
    if is_no_shell(&message) {
        return (exit_code(s), Some(NO_SHELL.into()));
    }
    match exit_code(s) {
        Some(code) => (Some(code), None),
        None => (None, (!message.is_empty()).then_some(message)),
    }
}
```

(`AppError::from(&kube::Error)` is the conversion `forward::kube` already uses.)

- [ ] **Step 3: Run** — `cd src-tauri && cargo test --lib exec::errors && cargo clippy --all-targets -- -D warnings` → 5 passed.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/exec/errors.rs src-tauri/src/exec/mod.rs
git commit -m "$(cat <<'EOF'
Map exec connect failures and exit statuses to user messages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 4: Exec sessions (connect, pump, input, resize, stop)

**Files:**
- Create: `src-tauri/src/exec/session.rs`
- Modify: `src-tauri/src/exec/mod.rs` (`pub mod session;`)

- [ ] **Step 1: Failing tests** — `session.rs`, tests first (they drive a fake connector over in-memory duplex pipes):

```rust
//! Live exec sessions: per terminal, a task that opens the connection, then pumps stdout to the
//! sink and the input queue to stdin (spec §4). Owned by the namespace `Session`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::ExecMessage;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use futures::FutureExt;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
    use tokio::sync::{mpsc, oneshot};

    #[derive(Clone)]
    enum Behaviour {
        Open,
        Fail(String),
        Hang,
    }

    /// The test's side of one fake process.
    struct Ends {
        stdout: DuplexStream,
        stdin: DuplexStream,
        resizes: Arc<Mutex<Vec<(u16, u16)>>>,
        status: oneshot::Sender<Option<Status>>,
        dropped: Arc<AtomicBool>,
        size: (u16, u16),
    }

    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    struct Fake {
        behaviour: Behaviour,
        ends: mpsc::UnboundedSender<Ends>,
    }

    impl ExecConnector for Fake {
        fn open(&self, _ns: &str, _pod: &str, _container: &str, cols: u16, rows: u16) -> BoxFuture<'static, Result<Process, String>> {
            let behaviour = self.behaviour.clone();
            let ends = self.ends.clone();
            async move {
                match behaviour {
                    Behaviour::Fail(m) => return Err(m),
                    Behaviour::Hang => futures::future::pending::<()>().await,
                    Behaviour::Open => {}
                }
                let (stdout_remote, stdout_test) = tokio::io::duplex(1024);
                let (stdin_remote, stdin_test) = tokio::io::duplex(1024);
                let resizes = Arc::new(Mutex::new(Vec::new()));
                let (status_tx, status_rx) = oneshot::channel();
                let dropped = Arc::new(AtomicBool::new(false));
                let seen = resizes.clone();
                ends.send(Ends {
                    stdout: stdout_test,
                    stdin: stdin_test,
                    resizes,
                    status: status_tx,
                    dropped: dropped.clone(),
                    size: (cols, rows),
                })
                .unwrap();
                Ok(Process {
                    stdin: Box::new(stdin_remote),
                    stdout: Box::new(stdout_remote),
                    resize: Box::new(move |c, r| seen.lock().unwrap().push((c, r))),
                    status: Box::pin(async move { status_rx.await.ok().flatten() }),
                    keep: Box::new(DropFlag(dropped)),
                })
            }
            .boxed()
        }
    }

    fn setup(behaviour: Behaviour) -> (ExecSessions, mpsc::UnboundedReceiver<Ends>, mpsc::UnboundedReceiver<ExecMessage>, u32) {
        let (ends_tx, ends_rx) = mpsc::unbounded_channel();
        let mut sessions = ExecSessions::new(Arc::new(Fake { behaviour, ends: ends_tx }));
        let (tx, rx) = mpsc::unbounded_channel();
        let req = ExecRequest { node_id: "Pod/shop/solo".into(), pod: "solo".into(), container: "main".into(), cols: 80, rows: 24 };
        let id = sessions.start("shop".into(), req, Arc::new(tx));
        (sessions, ends_rx, rx, id)
    }

    async fn next<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("in time").expect("open")
    }

    fn exit_status(code: i32) -> Status {
        Status {
            status: Some("Failure".into()),
            details: Some(StatusDetails {
                causes: Some(vec![StatusCause { reason: Some("ExitCode".into()), message: Some(code.to_string()), field: None }]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn output_is_forwarded_as_base64_with_the_initial_size() {
        let (_s, mut ends_rx, mut rx, id) = setup(Behaviour::Open);
        let mut ends = next(&mut ends_rx).await;
        assert_eq!(ends.size, (80, 24));
        ends.stdout.write_all(b"hi \x1b[31mred").await.unwrap();
        match next(&mut rx).await {
            ExecMessage::Output { session_id, data } => {
                assert_eq!(session_id, id);
                assert_eq!(STANDARD.decode(data).unwrap(), b"hi \x1b[31mred");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn input_and_resize_reach_the_process() {
        let (s, mut ends_rx, _rx, id) = setup(Behaviour::Open);
        let mut ends = next(&mut ends_rx).await;
        s.input(id, b"ls\n".to_vec());
        let mut buf = [0u8; 3];
        tokio::time::timeout(Duration::from_secs(5), ends.stdin.read_exact(&mut buf)).await.unwrap().unwrap();
        assert_eq!(&buf, b"ls\n");
        s.resize(id, 120, 40);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !ends.resizes.lock().unwrap().contains(&(120, 40)) {
            assert!(tokio::time::Instant::now() < deadline, "resize never arrived");
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn the_end_of_output_reports_the_exit_code() {
        let (_s, mut ends_rx, mut rx, id) = setup(Behaviour::Open);
        let ends = next(&mut ends_rx).await;
        ends.status.send(Some(exit_status(3))).unwrap();
        drop(ends.stdout);
        assert_eq!(next(&mut rx).await, ExecMessage::Ended { session_id: id, code: Some(3), message: None });
    }

    #[tokio::test]
    async fn a_failed_connect_is_an_error_message() {
        let (_s, _ends_rx, mut rx, id) = setup(Behaviour::Fail("No permission to exec into pods (pods/exec)".into()));
        assert_eq!(
            next(&mut rx).await,
            ExecMessage::Error { session_id: id, message: "No permission to exec into pods (pods/exec)".into() }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_hanging_connect_times_out() {
        let (_s, _ends_rx, mut rx, id) = setup(Behaviour::Hang);
        let msg = tokio::time::timeout(CONNECT_TIMEOUT * 2, rx.recv()).await.expect("in time").expect("open");
        assert_eq!(msg, ExecMessage::Error { session_id: id, message: TIMED_OUT.into() });
    }

    #[tokio::test]
    async fn stop_silences_the_session_and_drops_the_connection() {
        let (mut s, mut ends_rx, mut rx, id) = setup(Behaviour::Open);
        let mut ends = next(&mut ends_rx).await;
        s.stop(id);
        let _ = ends.stdout.write_all(b"late").await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !ends.dropped.load(Ordering::SeqCst) {
            assert!(tokio::time::Instant::now() < deadline, "the process was never dropped");
            tokio::task::yield_now().await;
        }
        assert!(rx.try_recv().is_err(), "nothing may arrive after stop");
        s.input(id, b"x".to_vec()); // unknown id now: a no-op
    }

    #[tokio::test]
    async fn stop_all_ends_every_session() {
        let (mut s, mut ends_rx, _rx, _id) = setup(Behaviour::Open);
        let (tx2, _rx2) = mpsc::unbounded_channel();
        let req = ExecRequest { node_id: "Pod/shop/solo".into(), pod: "solo".into(), container: "main".into(), cols: 80, rows: 24 };
        s.start("shop".into(), req, Arc::new(tx2));
        let a = next(&mut ends_rx).await;
        let b = next(&mut ends_rx).await;
        s.stop_all();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !(a.dropped.load(Ordering::SeqCst) && b.dropped.load(Ordering::SeqCst)) {
            assert!(tokio::time::Instant::now() < deadline, "sessions survived stop_all");
            tokio::task::yield_now().await;
        }
    }
}
```

Run: `cd src-tauri && cargo test --lib exec::session` → compile errors.

- [ ] **Step 2: Implement** — above the tests in `session.rs`:

```rust
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::session::watch::AbortOnDrop;

use super::{encode_output, errors, ClosableExecSink, ExecMessage, ExecSink};

/// Bounds opening the websocket (a hung API server must not leave "connecting…" forever).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long to wait for the exit status once the output has ended.
pub const STATUS_WAIT: Duration = Duration::from_secs(2);
pub const TIMED_OUT: &str = "timed out connecting to the container";
const READ_CHUNK: usize = 16 * 1024;

pub type Resize = Box<dyn FnMut(u16, u16) + Send>;

/// A started remote process as the session needs it: the kube `AttachedProcess` in the app, a
/// pair of in-memory pipes in the tests.
pub struct Process {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub resize: Resize,
    pub status: BoxFuture<'static, Option<Status>>,
    /// Owns the connection; dropping it closes the websocket.
    pub keep: Box<dyn Send>,
}

pub trait ExecConnector: Send + Sync + 'static {
    /// Open a TTY shell in `pod`/`container` sized `cols`×`rows`; the error is a user message.
    fn open(&self, namespace: &str, pod: &str, container: &str, cols: u16, rows: u16) -> BoxFuture<'static, Result<Process, String>>;
}

#[derive(Debug, Clone)]
pub struct ExecRequest {
    pub node_id: String,
    pub pod: String,
    pub container: String,
    pub cols: u16,
    pub rows: u16,
}

enum Input {
    Data(Vec<u8>),
    Resize(u16, u16),
}

struct Live {
    input: mpsc::UnboundedSender<Input>,
    sink: Arc<ClosableExecSink>,
    _task: AbortOnDrop,
}

pub struct ExecSessions {
    connector: Arc<dyn ExecConnector>,
    live: HashMap<u32, Live>,
    next_id: u32,
}

impl ExecSessions {
    pub fn new(connector: Arc<dyn ExecConnector>) -> Self {
        Self { connector, live: HashMap::new(), next_id: 1 }
    }

    /// Start a session for an already-validated request (see `targets::check_target`). Returns
    /// at once; connect failures arrive as `error` messages.
    pub fn start(&mut self, namespace: String, req: ExecRequest, sink: Arc<dyn ExecSink>) -> u32 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let sink = Arc::new(ClosableExecSink::new(sink));
        let (tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(session_task(id, self.connector.clone(), namespace, req, sink.clone(), rx));
        self.live.insert(id, Live { input: tx, sink, _task: AbortOnDrop(task) });
        id
    }

    /// Queue keystrokes (also while still connecting). Unknown ids are a no-op.
    pub fn input(&self, id: u32, data: Vec<u8>) {
        if let Some(live) = self.live.get(&id) {
            let _ = live.input.send(Input::Data(data));
        }
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) {
        if let Some(live) = self.live.get(&id) {
            let _ = live.input.send(Input::Resize(cols, rows));
        }
    }

    /// Nothing reaches the sink once this returns; dropping the task drops the connection.
    pub fn stop(&mut self, id: u32) {
        if let Some(live) = self.live.remove(&id) {
            live.sink.close();
        }
    }

    pub fn stop_all(&mut self) {
        for live in self.live.values() {
            live.sink.close();
        }
        self.live.clear();
    }
}

async fn session_task(
    id: u32,
    connector: Arc<dyn ExecConnector>,
    namespace: String,
    req: ExecRequest,
    sink: Arc<ClosableExecSink>,
    input: mpsc::UnboundedReceiver<Input>,
) {
    let opening = connector.open(&namespace, &req.pod, &req.container, req.cols, req.rows);
    let process = match tokio::time::timeout(CONNECT_TIMEOUT, opening).await {
        Ok(Ok(process)) => process,
        Ok(Err(message)) => return sink.send(ExecMessage::Error { session_id: id, message }),
        Err(_) => return sink.send(ExecMessage::Error { session_id: id, message: TIMED_OUT.into() }),
    };
    pump(id, process, sink, input).await;
}

async fn pump(id: u32, mut p: Process, sink: Arc<ClosableExecSink>, mut input: mpsc::UnboundedReceiver<Input>) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        tokio::select! {
            read = p.stdout.read(&mut buf) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => sink.send(ExecMessage::Output { session_id: id, data: encode_output(&buf[..n]) }),
            },
            msg = input.recv() => match msg {
                Some(Input::Data(bytes)) => {
                    if p.stdin.write_all(&bytes).await.is_err() || p.stdin.flush().await.is_err() {
                        break;
                    }
                }
                Some(Input::Resize(cols, rows)) => (p.resize)(cols, rows),
                // The session was stopped: its sink is closed, nothing more to say.
                None => return,
            },
        }
    }
    let status = tokio::time::timeout(STATUS_WAIT, p.status).await.ok().flatten();
    let (code, message) = errors::ended(status.as_ref());
    sink.send(ExecMessage::Ended { session_id: id, code, message });
    drop(p.keep);
}
```

(`AbortOnDrop` is the `pub struct AbortOnDrop(pub JoinHandle<()>)` in `session/watch.rs` that `logs::session` already uses. `session_task` returns `()`, so `return sink.send(..)` type-checks.)

- [ ] **Step 3: Run** — `cd src-tauri && for i in 1 2 3; do cargo test --lib exec::session || break; done && cargo clippy --all-targets -- -D warnings` → 7 passed three times; clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/exec/session.rs src-tauri/src/exec/mod.rs
git commit -m "$(cat <<'EOF'
Run exec sessions: connect with a timeout, pump output, queue input and resizes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 5: The kube connector, Session methods and Tauri commands

**Files:**
- Create: `src-tauri/src/exec/remote.rs`
- Modify: `src-tauri/src/exec/mod.rs` (`pub mod remote;`), `src-tauri/src/session/mod.rs`, `src-tauri/src/commands.rs`

- [ ] **Step 1: The connector** — `src-tauri/src/exec/remote.rs` (named `remote`, not `kube`, so `kube::` paths inside the `exec` module keep meaning the crate):

```rust
//! The real `ExecConnector`: `kubectl exec -it` over the API server's websocket.

use futures::future::BoxFuture;
use futures::FutureExt;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, TerminalSize};
use kube::Client;

use super::errors::start_error;
use super::session::{ExecConnector, Process};
use super::SHELL;

pub struct KubeExec {
    client: Client,
}

impl KubeExec {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

impl ExecConnector for KubeExec {
    fn open(&self, namespace: &str, pod: &str, container: &str, cols: u16, rows: u16) -> BoxFuture<'static, Result<Process, String>> {
        let api: Api<Pod> = Api::namespaced(self.client.clone(), namespace);
        let (pod, container) = (pod.to_string(), container.to_string());
        async move {
            let params = AttachParams::interactive_tty().container(container);
            let mut proc = api.exec(&pod, SHELL, &params).await.map_err(|e| start_error(&e))?;
            let stdin = proc.stdin().ok_or("the exec stream has no stdin")?;
            let stdout = proc.stdout().ok_or("the exec stream has no stdout")?;
            let status = proc.take_status().ok_or("the exec stream has no status channel")?;
            let mut sizes = proc.terminal_size();
            if let Some(tx) = sizes.as_mut() {
                let _ = tx.try_send(TerminalSize { width: cols, height: rows });
            }
            Ok(Process {
                stdin: Box::new(stdin),
                stdout: Box::new(stdout),
                resize: Box::new(move |width, height| {
                    if let Some(tx) = sizes.as_mut() {
                        let _ = tx.try_send(TerminalSize { width, height });
                    }
                }),
                status: Box::pin(status),
                keep: Box::new(proc),
            })
        }
        .boxed()
    }
}
```

If `AttachParams`/`TerminalSize` are not re-exported at `kube::api`, import them from where `forward::kube` imports `Portforwarder` (`kube::api::…`) or from `kube::core::subresource::AttachParams` / `kube::api::TerminalSize`; check `kube-client-4.2.0/src/api/mod.rs` (`pub use remote_command::{AttachedProcess, TerminalSize}` behind `ws`). `ok_or("…")?` needs `String: From<&str>` — it is.

- [ ] **Step 2: Session wiring** — `src-tauri/src/session/mod.rs`:

Imports (next to the logs imports):

```rust
use crate::exec::remote::KubeExec;
use crate::exec::session::{ExecRequest, ExecSessions};
use crate::exec::{ExecPod, ExecSink};
```

Field in `pub struct Session` (after `next_log_id`):

```rust
    /// Live terminals; they end with the namespace session, like log sessions.
    execs: ExecSessions,
```

In `fn new` (after `next_log_id: 1,`):

```rust
            execs: ExecSessions::new(Arc::new(KubeExec::new(client.clone()))),
```

(`client` is moved into the struct field `client` — put the `execs` line before `client` is moved, or build `let execs = …;` at the top of `new` next to `forwards`.)

In `fn stop_watchers`, right after `self.logs.clear();`:

```rust
        self.execs.stop_all();
```

Methods (after `stop_logs`):

```rust
    /// The running pods and containers the Terminal tab offers for `node_id`.
    pub fn exec_pods(&self, node_id: &str) -> AppResult<Vec<ExecPod>> {
        crate::exec::targets::exec_pods(&self.shared.store(), node_id)
    }

    /// Validate against the store and start a terminal; connect errors arrive as messages.
    pub fn start_exec(&mut self, req: ExecRequest, sink: Arc<dyn ExecSink>) -> AppResult<u32> {
        let namespace = crate::exec::targets::check_target(&self.shared.store(), &req.node_id, &req.pod, &req.container)?;
        Ok(self.execs.start(namespace, req, sink))
    }

    pub fn exec_input(&self, id: u32, data: Vec<u8>) {
        self.execs.input(id, data);
    }

    pub fn exec_resize(&self, id: u32, cols: u16, rows: u16) {
        self.execs.resize(id, cols, rows);
    }

    pub fn stop_exec(&mut self, id: u32) {
        self.execs.stop(id);
    }
```

- [ ] **Step 3: Commands** — `src-tauri/src/commands.rs`, imports:

```rust
use crate::exec::session::ExecRequest;
use crate::exec::{clamp_size, decode_input, ExecMessage, ExecPod};
```

After `stop_logs`:

```rust
#[tauri::command]
pub async fn exec_pods(state: State<'_, AppState>, node_id: String) -> AppResult<Vec<ExecPod>> {
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.exec_pods(&node_id)
}

/// Open a terminal in `pod`/`container` of `node_id`; output and the end arrive on `on_message`.
#[tauri::command]
pub async fn start_exec(
    state: State<'_, AppState>,
    node_id: String,
    pod: String,
    container: String,
    cols: u16,
    rows: u16,
    on_message: tauri::ipc::Channel<ExecMessage>,
) -> AppResult<u32> {
    let (cols, rows) = clamp_size(cols, rows);
    let mut guard = state.session.lock().await;
    let session = session_mut(&mut guard)?;
    session.start_exec(ExecRequest { node_id, pod, container, cols, rows }, Arc::new(on_message))
}

/// Keystrokes (base64). Unknown sessions and a missing connection are no-ops.
#[tauri::command]
pub async fn exec_input(state: State<'_, AppState>, session_id: u32, data: String) -> AppResult<()> {
    let bytes = decode_input(&data)?;
    let guard = state.session.lock().await;
    if let Some(session) = guard.as_ref() {
        session.exec_input(session_id, bytes);
    }
    Ok(())
}

#[tauri::command]
pub async fn exec_resize(state: State<'_, AppState>, session_id: u32, cols: u16, rows: u16) -> AppResult<()> {
    let (cols, rows) = clamp_size(cols, rows);
    let guard = state.session.lock().await;
    if let Some(session) = guard.as_ref() {
        session.exec_resize(session_id, cols, rows);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_exec(state: State<'_, AppState>, session_id: u32) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    if let Some(session) = guard.as_mut() {
        session.stop_exec(session_id);
    }
    Ok(())
}
```

Register in `generate_handler!` after `stop_logs,`: `exec_pods, start_exec, exec_input, exec_resize, stop_exec,`.

- [ ] **Step 4: Run** — `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` → all green (no new unit tests here: the connector needs a cluster, Task 7 covers it).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/exec/remote.rs src-tauri/src/exec/mod.rs src-tauri/src/session/mod.rs src-tauri/src/commands.rs
git commit -m "$(cat <<'EOF'
Wire exec sessions into the session and expose the terminal commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 6: IPC contract and fixtures

**Files:**
- Create: `src/shared/ipc/fixtures/exec_message.json`, `src/shared/ipc/fixtures/exec_pod.json`
- Modify: `src-tauri/tests/ipc_fixtures.rs`, `docs/ipc-contract.md`

- [ ] **Step 1: Failing fixture test** — append to `src-tauri/tests/ipc_fixtures.rs` (add `use wiring_lib::exec::{ExecMessage, ExecPod};` to the imports):

```rust
#[test]
fn exec_message_and_pod() {
    assert_matches("exec_message", &ExecMessage::Output { session_id: 2, data: "aGkK".into() });
    assert_matches("exec_pod", &ExecPod { name: "web-7f9c-a".into(), containers: vec!["app".into(), "sidecar".into()] });
}
```

Run: `cd src-tauri && cargo test --test ipc_fixtures exec` → fails (fixture files missing).

- [ ] **Step 2: Fixtures**

`src/shared/ipc/fixtures/exec_message.json`:

```json
{ "type": "output", "sessionId": 2, "data": "aGkK" }
```

`src/shared/ipc/fixtures/exec_pod.json`:

```json
{ "name": "web-7f9c-a", "containers": ["app", "sidecar"] }
```

- [ ] **Step 3: Contract** — in `docs/ipc-contract.md` add rows to the Commands table (after `stop_logs`):

```markdown
| `exec_pods` | `{ nodeId }` | `ExecPod[]` — running pods of a Pod / Deployment / StatefulSet / DaemonSet / Job / PodGroup with their regular containers; other kinds `invalid` |
| `start_exec` | `{ nodeId, pod, container, cols, rows, onMessage: Channel<ExecMessage> }` | `number` session id; see [Exec](#exec) |
| `exec_input` | `{ sessionId, data }` | `null` — `data` is base64 keystrokes; not base64 → `invalid` |
| `exec_resize` | `{ sessionId, cols, rows }` | `null` |
| `stop_exec` | `{ sessionId }` | `null` — nothing reaches the channel afterwards |
```

and a section after "Logs":

```markdown
## Exec

`start_exec` checks the request against the cached store (`pod` must be a running pod of `nodeId`, `container` one of its regular containers — otherwise `invalid` / `notFound`) and returns at once. The session then opens `sh -c "command -v bash >/dev/null && exec bash || exec sh"` with a TTY of `cols`×`rows` (each clamped to 1…1000) and pushes `ExecMessage`s (tagged by `type`) through the channel:

- `{ type: "output", sessionId, data }` — `data` is base64 of the raw TTY bytes, chunked as they arrive.
- `{ type: "ended", sessionId, code, message }` — the shell exited: `code` from the exit status (`0` on success, `null` when unknown); `message` is `"This container has no shell (distroless image?)"` when the image has no `sh`, the server's message for other failures, else `null`.
- `{ type: "error", sessionId, message }` — the connection could not be opened: `"No permission to exec into pods (pods/exec)"`, `"timed out connecting to the container"` (15 s), or the API error.

Input sent before the connection is up is queued. Sessions end with the namespace session (namespace switch, disconnect) like log sessions. Nothing typed or printed is logged.
```

- [ ] **Step 4: Run** — `cd src-tauri && cargo test --test ipc_fixtures` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc/fixtures/exec_message.json src/shared/ipc/fixtures/exec_pod.json src-tauri/tests/ipc_fixtures.rs docs/ipc-contract.md
git commit -m "$(cat <<'EOF'
Document the exec commands and messages in the IPC contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 7: Smoke test (docker-desktop only)

**Files:**
- Modify: `src-tauri/tests/smoke.rs`

- [ ] **Step 1: Add the exercise** — imports:

```rust
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use wiring_lib::exec::session::ExecRequest;
use wiring_lib::exec::{ExecMessage, ExecPod};
```

Add before `graph_snapshot_reflects_applied_fixture`:

```rust
/// The running pods of `node_id` once the store has them.
async fn exec_pods_until_running(session: &Session, node_id: &str) -> Vec<ExecPod> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        if let Ok(pods) = session.exec_pods(node_id) {
            if !pods.is_empty() {
                return pods;
            }
        }
        assert!(tokio::time::Instant::now() < deadline, "{node_id} never had a running pod");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn exercise_exec(session: &mut Session, context: &str) {
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "deployment/talker", "--timeout=180s"]);
    let talker = format!("Deployment/{NAMESPACE}/talker");
    let pods = exec_pods_until_running(session, &talker).await;
    assert_eq!(pods[0].containers, vec!["talker".to_string()]);

    let (tx, mut rx) = mpsc::unbounded_channel::<ExecMessage>();
    let req = ExecRequest { node_id: talker.clone(), pod: pods[0].name.clone(), container: "talker".into(), cols: 120, rows: 30 };
    let id = session.start_exec(req, Arc::new(tx)).unwrap();
    // Queued until the shell is up. The TTY echoes the command line, which contains
    // `wiring-$((6*7))`, so only the evaluated `wiring-42` proves the shell ran it.
    session.exec_input(id, b"echo wiring-$((6*7))\n".to_vec());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut out = String::new();
    while !out.contains("wiring-42") {
        match tokio::time::timeout_at(deadline, rx.recv()).await.expect("exec output in time").expect("channel open") {
            ExecMessage::Output { data, .. } => out.push_str(&String::from_utf8_lossy(&STANDARD.decode(data).unwrap())),
            other => panic!("unexpected {other:?}; output so far: {out}"),
        }
    }
    session.exec_input(id, b"exit 3\n".to_vec());
    let code = loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await.expect("exec end in time").expect("channel open") {
            ExecMessage::Output { .. } => continue,
            ExecMessage::Ended { code, .. } => break code,
            ExecMessage::Error { message, .. } => panic!("exec error: {message}"),
        }
    };
    assert_eq!(code, Some(3));
    session.stop_exec(id);

    // `db` runs the pause image, which has no shell.
    let db = format!("StatefulSet/{NAMESPACE}/db");
    let pods = exec_pods_until_running(session, &db).await;
    let (tx, mut rx) = mpsc::unbounded_channel::<ExecMessage>();
    let req = ExecRequest { node_id: db, pod: pods[0].name.clone(), container: "db".into(), cols: 80, rows: 24 };
    let id = session.start_exec(req, Arc::new(tx)).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let message = loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await.expect("no-shell outcome in time").expect("channel open") {
            ExecMessage::Output { .. } => continue,
            ExecMessage::Ended { message, code, .. } => break format!("{message:?} (code {code:?})"),
            ExecMessage::Error { message, .. } => break message,
        }
    };
    assert!(message.contains("no shell"), "expected the no-shell message, got {message}");
    session.stop_exec(id);

    // A pod outside the workload is refused before any connection.
    let req = ExecRequest { node_id: talker, pod: "not-a-talker".into(), container: "talker".into(), cols: 80, rows: 24 };
    let err = session.start_exec(req, Arc::new(mpsc::unbounded_channel::<ExecMessage>().0)).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
}
```

Call it after `exercise_logs(&mut session, &context).await;`:

```rust
    exercise_exec(&mut session, &context).await;
```

- [ ] **Step 2: Run (only the local context)**

Run: `cd src-tauri && WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored --nocapture`
Expected: 1 passed. If the pause image reports the missing shell differently (e.g. only an exit code 126/127, or a 500 at upgrade), adjust `errors::ended` / `errors::start_error` to recognise what the server actually sends (keep the unit tests in `errors.rs` in sync) — do not loosen the smoke assertion.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tests/smoke.rs src-tauri/src/exec/errors.rs
git commit -m "$(cat <<'EOF'
Smoke-test a shell in a busybox pod, its exit code and a shell-less image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 8: Frontend dependencies, types, commands and base64

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `src/shared/ipc/types.ts`, `src/shared/ipc/commands.ts`, `src/shared/ipc/fixtures.test.ts`
- Create: `src/features/exec/base64.ts`, `src/features/exec/base64.test.ts`

- [ ] **Step 1: Dependencies**

Run: `pnpm add @xterm/xterm@^5.5.0 @xterm/addon-fit@^0.10.0`

- [ ] **Step 2: Failing tests**

Append to `src/shared/ipc/fixtures.test.ts` (imports at the top with the others):

```ts
import execMessage from "./fixtures/exec_message.json";
import execPod from "./fixtures/exec_pod.json";
// …
it("exec_message", () => expect(isExecMessage(execMessage)).toBe(true));
it("exec_pod", () => expect(isExecPod(execPod)).toBe(true));
it("exec message variants", () => {
  expect(isExecMessage({ type: "ended", sessionId: 1, code: 3, message: null })).toBe(true);
  expect(isExecMessage({ type: "ended", sessionId: 1, code: null, message: "x" })).toBe(true);
  expect(isExecMessage({ type: "error", sessionId: 1, message: "x" })).toBe(true);
  expect(isExecMessage({ type: "output", sessionId: 1 })).toBe(false);
  expect(isExecPod({ name: "p", containers: [1] })).toBe(false);
});
```

(add `isExecMessage, isExecPod` to the `./types` import.)

`src/features/exec/base64.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeBytes, encodeText } from "./base64";

describe("base64", () => {
  it("encodes text as UTF-8", () => {
    expect(encodeText("hi\n")).toBe("aGkK");
    expect(new TextDecoder().decode(decodeBytes(encodeText("héllo ✓")))).toBe("héllo ✓");
  });
  it("decodes raw bytes", () => {
    expect([...decodeBytes("G1szMW0=")]).toEqual([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
  });
});
```

Run: `pnpm test -- src/shared/ipc src/features/exec` → fails (missing exports/module).

- [ ] **Step 3: Implement**

`src/shared/ipc/types.ts` — after the Logs types:

```ts
export interface ExecPod { name: string; containers: string[] }
export type ExecMessage =
  | { type: "output"; sessionId: number; data: string }
  | { type: "ended"; sessionId: number; code: number | null; message: string | null }
  | { type: "error"; sessionId: number; message: string };
export interface ExecRequest { nodeId: NodeId; pod: string; container: string; cols: number; rows: number }
```

and with the other guards:

```ts
export function isExecPod(v: unknown): v is ExecPod { return isObj(v) && isStr(v.name) && arrayOf(v.containers, isStr); }
export function isExecMessage(v: unknown): v is ExecMessage {
  if (!isObj(v) || typeof v.sessionId !== "number") return false;
  switch (v.type) {
    case "output": return isStr(v.data);
    case "ended": return (v.code === null || typeof v.code === "number") && isStrOrNull(v.message);
    case "error": return isStr(v.message);
    default: return false;
  }
}
```

`src/shared/ipc/commands.ts` — add `ExecMessage, ExecPod, ExecRequest` to the type import and, after `stopLogs`:

```ts
  execPods: (nodeId: NodeId) => call<ExecPod[]>("exec_pods", { nodeId }),
  /** Returns at once; output, the end and connect errors arrive on `onMessage`. */
  startExec: (req: ExecRequest, onMessage: (m: ExecMessage) => void) => {
    const channel = new Channel<ExecMessage>();
    channel.onmessage = onMessage;
    return call<number>("start_exec", { ...req, onMessage: channel });
  },
  /** `data` is base64. */
  execInput: (sessionId: number, data: string) => call<null>("exec_input", { sessionId, data }),
  execResize: (sessionId: number, cols: number, rows: number) => call<null>("exec_resize", { sessionId, cols, rows }),
  stopExec: (sessionId: number) => call<null>("stop_exec", { sessionId }),
```

`src/features/exec/base64.ts`:

```ts
/** Keystrokes → base64 of their UTF-8 bytes (the `exec_input` format). */
export function encodeText(text: string): string {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** `output` data → raw bytes; xterm decodes UTF-8 itself, also across chunk boundaries. */
export function decodeBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
```

- [ ] **Step 4: Run** — `pnpm typecheck && pnpm test` → green.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/shared/ipc/types.ts src/shared/ipc/commands.ts src/shared/ipc/fixtures.test.ts src/features/exec/base64.ts src/features/exec/base64.test.ts
git commit -m "$(cat <<'EOF'
Add xterm and the exec IPC types, guards, commands and base64 helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 9: The lazy xterm wrapper and `useExecSession`

**Files:**
- Create: `src/features/exec/terminal.ts`, `src/features/exec/useExecSession.ts`, `src/features/exec/useExecSession.test.tsx`

- [ ] **Step 1: Failing hook tests** — `useExecSession.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecMessage } from "../../shared/ipc/types";
import { encodeText } from "./base64";
import { endLine, useExecSession } from "./useExecSession";

const startExec = vi.fn();
const stopExec = vi.fn();
const execInput = vi.fn();
const execResize = vi.fn();
vi.mock("../../shared/ipc/commands", () => ({
  commands: {
    startExec: (...a: unknown[]) => startExec(...a),
    stopExec: (...a: unknown[]) => stopExec(...a),
    execInput: (...a: unknown[]) => execInput(...a),
    execResize: (...a: unknown[]) => execResize(...a),
  },
}));

const req = { nodeId: "Pod/shop/solo", pod: "solo", container: "main", cols: 80, rows: 24 };
let push: (m: ExecMessage) => void;

beforeEach(() => {
  vi.clearAllMocks();
  let next = 1;
  startExec.mockImplementation(async (_req: unknown, onMessage: (m: ExecMessage) => void) => { push = onMessage; return next++; });
  stopExec.mockResolvedValue(null);
  execInput.mockResolvedValue(null);
  execResize.mockResolvedValue(null);
});

function setup() {
  const onOutput = vi.fn();
  const onEnd = vi.fn();
  const hook = renderHook(() => useExecSession({ onOutput, onEnd }));
  return { ...hook, onOutput, onEnd };
}

describe("useExecSession", () => {
  it("connects, forwards output bytes and becomes open", async () => {
    const { result, onOutput } = setup();
    await act(() => result.current.connect(req));
    expect(startExec).toHaveBeenCalledWith(req, expect.any(Function));
    expect(result.current.status).toBe("connecting");
    act(() => push({ type: "output", sessionId: 1, data: "aGkK" }));
    expect([...onOutput.mock.calls[0][0]]).toEqual([0x68, 0x69, 0x0a]);
    expect(result.current.status).toBe("open");
  });

  it("sends keystrokes and resizes to the session", async () => {
    const { result } = setup();
    await act(() => result.current.connect(req));
    act(() => result.current.send("ls\r"));
    expect(execInput).toHaveBeenCalledWith(1, encodeText("ls\r"));
    act(() => result.current.resize(100, 40));
    expect(execResize).toHaveBeenCalledWith(1, 100, 40);
  });

  it("ends with a line naming the exit code", async () => {
    const { result, onEnd } = setup();
    await act(() => result.current.connect(req));
    act(() => push({ type: "ended", sessionId: 1, code: 3, message: null }));
    expect(result.current.status).toBe("ended");
    expect(onEnd).toHaveBeenCalledWith(endLine({ type: "ended", sessionId: 1, code: 3, message: null }));
    expect(endLine({ type: "ended", sessionId: 1, code: 3, message: null })).toContain("exit code 3");
    expect(endLine({ type: "error", sessionId: 1, message: "No permission" })).toContain("No permission");
  });

  it("reconnecting stops the old session and ignores its late messages", async () => {
    const { result, onOutput } = setup();
    await act(() => result.current.connect(req));
    const old = push;
    await act(() => result.current.connect(req));
    expect(stopExec).toHaveBeenCalledWith(1);
    act(() => old({ type: "output", sessionId: 1, data: "aGkK" }));
    expect(onOutput).not.toHaveBeenCalled();
  });

  it("a rejected start ends with its message", async () => {
    startExec.mockRejectedValueOnce({ kind: "invalid", message: "pod gone" });
    const { result, onEnd } = setup();
    await act(() => result.current.connect(req));
    expect(result.current.status).toBe("ended");
    expect(onEnd.mock.calls[0][0]).toContain("pod gone");
  });

  it("unmount stops the session", async () => {
    const { result, unmount } = setup();
    await act(() => result.current.connect(req));
    unmount();
    expect(stopExec).toHaveBeenCalledWith(1);
  });
});
```

Run: `pnpm test -- src/features/exec/useExecSession` → fails (module missing).

- [ ] **Step 2: Implement** — `useExecSession.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type ExecMessage, type ExecRequest } from "../../shared/ipc/types";
import { decodeBytes, encodeText } from "./base64";

export type ExecStatus = "idle" | "connecting" | "open" | "ended";
export interface ExecHandlers { onOutput(bytes: Uint8Array): void; onEnd(line: string): void }

/** The line written into the terminal when a session ends or fails. */
export function endLine(m: Exclude<ExecMessage, { type: "output" }>): string {
  if (m.type === "error") return `\r\n[${m.message}]\r\n`;
  const code = m.code !== null ? ` (exit code ${m.code})` : "";
  return `\r\n[${m.message ? `${m.message} · ` : ""}session ended${code}]\r\n`;
}

/** One exec session at a time: `connect` replaces any previous one; unmount stops it. */
export function useExecSession(handlers: ExecHandlers) {
  const [status, setStatus] = useState<ExecStatus>("idle");
  const sessionId = useRef<number | null>(null);
  const generation = useRef(0);
  const h = useRef(handlers);
  h.current = handlers;

  const stop = useCallback(() => {
    generation.current++;
    const id = sessionId.current;
    sessionId.current = null;
    if (id !== null) void commands.stopExec(id);
  }, []);

  const connect = useCallback(async (req: ExecRequest) => {
    stop();
    const mine = generation.current;
    setStatus("connecting");
    try {
      const id = await commands.startExec(req, (m) => {
        if (mine !== generation.current) return;
        if (m.type === "output") {
          setStatus("open");
          h.current.onOutput(decodeBytes(m.data));
        } else {
          sessionId.current = null;
          setStatus("ended");
          h.current.onEnd(endLine(m));
        }
      });
      if (mine !== generation.current) { void commands.stopExec(id); return; }
      sessionId.current = id;
    } catch (e) {
      if (mine !== generation.current) return;
      setStatus("ended");
      h.current.onEnd(`\r\n[${toAppError(e).message}]\r\n`);
    }
  }, [stop]);

  const send = useCallback((text: string) => {
    const id = sessionId.current;
    if (id !== null) void commands.execInput(id, encodeText(text));
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    const id = sessionId.current;
    if (id !== null) void commands.execResize(id, cols, rows);
  }, []);

  const disconnect = useCallback(() => {
    const wasLive = sessionId.current !== null;
    stop();
    setStatus("ended");
    if (wasLive) h.current.onEnd("\r\n[session ended]\r\n");
  }, [stop]);

  useEffect(() => stop, [stop]);
  return { status, connect, send, resize, disconnect };
}
```

Note the generation bump in `stop()` happens before `connect` reads `mine`, so a reconnect invalidates the old callback; `connect` must read `generation.current` after `stop()` (as written).

`terminal.ts` (no unit test: it is the xterm boundary and is mocked in the tab tests; it is only ever loaded through `import("./terminal")`, so xterm lands in its own chunk):

```ts
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export interface TermHandle {
  write(data: Uint8Array | string): void;
  onData(cb: (data: string) => void): void;
  onResize(cb: (cols: number, rows: number) => void): void;
  fit(): void;
  readonly cols: number;
  readonly rows: number;
  focus(): void;
  dispose(): void;
}

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

function theme(): ITheme {
  return {
    background: css("--color-surface", "#2d2734"),
    foreground: css("--color-text-hi", "#f1f0ec"),
    cursor: css("--color-accent", "#b997ff"),
    selectionBackground: "#b997ff55",
    red: css("--color-status-err", "#ff5632"),
    green: css("--color-status-ok", "#00f575"),
    yellow: css("--color-status-warn", "#ffb547"),
  };
}

export function createTerminal(el: HTMLElement): TermHandle {
  const term = new Terminal({ fontFamily: css("--font-mono", "monospace"), fontSize: 13, scrollback: 5000, cursorBlink: true, macOptionIsMeta: true, theme: theme() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // xterm draws its selection itself, so the native Copy cannot see it: ⌘C / Ctrl+Shift+C copy it here.
  term.attachCustomKeyEventHandler((e) => {
    const copy = e.type === "keydown" && e.key.toLowerCase() === "c" && (e.metaKey || (e.ctrlKey && e.shiftKey));
    if (copy && term.hasSelection()) { void navigator.clipboard.writeText(term.getSelection()); return false; }
    return true;
  });
  fit.fit();
  return {
    write: (data) => term.write(data),
    onData: (cb) => { term.onData(cb); },
    onResize: (cb) => { term.onResize(({ cols, rows }) => cb(cols, rows)); },
    fit: () => fit.fit(),
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
}
```

(If `tsc` complains about the side-effect CSS import, the project's `vite/client` types already declare `*.css`; check `tsconfig.json` `types` and add `"vite/client"` only if missing.)

- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test` → green.

- [ ] **Step 4: Commit**

```bash
git add src/features/exec/terminal.ts src/features/exec/useExecSession.ts src/features/exec/useExecSession.test.tsx
git commit -m "$(cat <<'EOF'
Bridge xterm to exec sessions: lazy terminal wrapper and useExecSession

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 10: The Terminal tab

**Files:**
- Create: `src/features/exec/TerminalTab.tsx`, `src/features/exec/TerminalTab.test.tsx`

- [ ] **Step 1: Failing tests** — `TerminalTab.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecMessage } from "../../shared/ipc/types";
import { TerminalTab } from "./TerminalTab";

const fakeTerm = {
  write: vi.fn(), onData: vi.fn(), onResize: vi.fn(), fit: vi.fn(), focus: vi.fn(), dispose: vi.fn(),
  cols: 100, rows: 30,
};
vi.mock("./terminal", () => ({ createTerminal: vi.fn(() => fakeTerm) }));

const execPods = vi.fn();
const startExec = vi.fn();
const stopExec = vi.fn();
vi.mock("../../shared/ipc/commands", () => ({
  commands: {
    execPods: (...a: unknown[]) => execPods(...a),
    startExec: (...a: unknown[]) => startExec(...a),
    stopExec: (...a: unknown[]) => stopExec(...a),
    execInput: vi.fn(async () => null),
    execResize: vi.fn(async () => null),
  },
}));

let push: (m: ExecMessage) => void;
beforeEach(() => {
  vi.clearAllMocks();
  execPods.mockResolvedValue([
    { name: "web-a", containers: ["app", "sidecar"] },
    { name: "web-b", containers: ["app"] },
  ]);
  startExec.mockImplementation(async (_r: unknown, onMessage: (m: ExecMessage) => void) => { push = onMessage; return 7; });
  stopExec.mockResolvedValue(null);
});

describe("TerminalTab", () => {
  it("offers the workload's pods and their containers, and connects to the chosen one", async () => {
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    const pod = await screen.findByRole("combobox", { name: "Pod" });
    fireEvent.change(pod, { target: { value: "web-b" } });
    expect((screen.getByRole("combobox", { name: "Container" }) as HTMLSelectElement).value).toBe("app");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    expect(startExec.mock.calls[0][0]).toEqual({ nodeId: "Deployment/shop/web", pod: "web-b", container: "app", cols: 100, rows: 30 });
    expect(fakeTerm.focus).toHaveBeenCalled();
  });

  it("has no pod picker for a Pod", async () => {
    execPods.mockResolvedValue([{ name: "solo", containers: ["main"] }]);
    render(<TerminalTab nodeId="Pod/shop/solo" />);
    await screen.findByRole("combobox", { name: "Container" });
    expect(screen.queryByRole("combobox", { name: "Pod" })).toBeNull();
  });

  it("writes output and offers Reconnect after the session ends", async () => {
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    act(() => push({ type: "output", sessionId: 7, data: "aGkK" }));
    expect(fakeTerm.write).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    act(() => push({ type: "ended", sessionId: 7, code: 0, message: null }));
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(fakeTerm.write).toHaveBeenLastCalledWith(expect.stringContaining("session ended"));
  });

  it("says so when there is no running pod", async () => {
    execPods.mockResolvedValue([]);
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    expect(await screen.findByText("No running pods to open a terminal in.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("keeps keys typed in the terminal away from app shortcuts", async () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    await screen.findByRole("button", { name: "Connect" });
    const box = document.querySelector("[data-terminal]")!;
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.keyDown(box, { key: "k", metaKey: true });
    expect(onWindowKey).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onWindowKey);
  });

  it("stops the session and disposes the terminal on unmount", async () => {
    const { unmount } = render(<TerminalTab nodeId="Deployment/shop/web" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    unmount();
    expect(stopExec).toHaveBeenCalledWith(7);
    expect(fakeTerm.dispose).toHaveBeenCalled();
  });
});
```

Run: `pnpm test -- src/features/exec/TerminalTab` → fails (module missing).

- [ ] **Step 2: Implement** — `TerminalTab.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type ExecPod, type NodeId } from "../../shared/ipc/types";
import type { TermHandle } from "./terminal";
import { useExecSession } from "./useExecSession";

const select = "h-8 rounded-lg border border-border bg-surface px-2 text-xs text-text-hi";
const action = "h-8 rounded-lg border border-border px-3 text-xs font-medium text-text-hi hover:bg-surface disabled:opacity-40";

/** An interactive shell in a running container of the selected Pod or workload (spec §3). */
export function TerminalTab({ nodeId }: { nodeId: NodeId }) {
  const [pods, setPods] = useState<ExecPod[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pod, setPod] = useState("");
  const [container, setContainer] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<TermHandle | null>(null);
  const session = useExecSession({
    onOutput: (bytes) => term.current?.write(bytes),
    onEnd: (line) => term.current?.write(line),
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const isPod = nodeId.startsWith("Pod/");

  useEffect(() => {
    let live = true;
    commands.execPods(nodeId).then(
      (list) => {
        if (!live) return;
        setPods(list);
        setPod(list[0]?.name ?? "");
        setContainer(list[0]?.containers[0] ?? "");
      },
      (e) => { if (live) setLoadError(toAppError(e).message); },
    );
    return () => { live = false; };
  }, [nodeId]);

  // Keys typed in the terminal belong to the shell: keep them from the app's window shortcuts.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const swallow = (e: KeyboardEvent) => e.stopPropagation();
    el.addEventListener("keydown", swallow);
    return () => el.removeEventListener("keydown", swallow);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => term.current?.fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => { term.current?.dispose(); term.current = null; }, []);

  async function ensureTerminal(): Promise<TermHandle | null> {
    if (term.current) return term.current;
    if (!box.current) return null;
    const { createTerminal } = await import("./terminal");
    const t = createTerminal(box.current);
    t.onData((data) => sessionRef.current.send(data));
    t.onResize((cols, rows) => sessionRef.current.resize(cols, rows));
    term.current = t;
    return t;
  }

  async function connect() {
    const t = await ensureTerminal();
    if (!t || !pod || !container) return;
    t.focus();
    await session.connect({ nodeId, pod, container, cols: t.cols, rows: t.rows });
  }

  const containers = pods?.find((p) => p.name === pod)?.containers ?? [];
  const live = session.status === "connecting" || session.status === "open";
  const label = live ? "Disconnect" : session.status === "ended" ? "Reconnect" : "Connect";

  let notice: string | null = null;
  if (loadError) notice = `Could not list pods: ${loadError}`;
  else if (pods && pods.length === 0) notice = "No running pods to open a terminal in.";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5">
        {pods && pods.length > 0 && (
          <>
            {!isPod && (
              <select aria-label="Pod" className={select} value={pod} disabled={live}
                onChange={(e) => { setPod(e.target.value); setContainer(pods.find((p) => p.name === e.target.value)?.containers[0] ?? ""); }}>
                {pods.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            )}
            <select aria-label="Container" className={select} value={container} disabled={live} onChange={(e) => setContainer(e.target.value)}>
              {containers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button type="button" className={action} onClick={() => (live ? session.disconnect() : void connect())}>{label}</button>
            <span className="ml-auto text-xs text-text-muted">{session.status === "connecting" ? "connecting…" : session.status === "open" ? "connected" : ""}</span>
          </>
        )}
        {notice && <span className="text-xs text-text-muted">{notice}</span>}
      </div>
      <div ref={box} data-terminal className="min-h-0 flex-1 bg-surface px-3 py-2" />
    </div>
  );
}
```

- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test` → green.

- [ ] **Step 4: Commit**

```bash
git add src/features/exec/TerminalTab.tsx src/features/exec/TerminalTab.test.tsx
git commit -m "$(cat <<'EOF'
Add the Terminal tab: pod and container pickers, connect, live xterm view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 11: Terminal tab in the details panel

**Files:**
- Modify: `src/app/store.ts`, `src/features/details/DetailsPanel.tsx`, `src/features/details/DetailsPanel.test.tsx`

- [ ] **Step 1: Failing test** — in `DetailsPanel.test.tsx`, following the file's existing pattern for the Logs/History tab tests (same store seeding helper), add:

```tsx
it("offers a Terminal tab for pods and pod-running workloads only", async () => {
  // Seed the store with a selected Deployment, as the Logs-tab test does, then:
  expect(screen.getByRole("tab", { name: "Terminal" })).toBeTruthy();
  // Re-seed with a Service selected:
  expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
});
```

Write it concretely with the helper the file already uses to select a node (e.g. the one behind the "Logs tab" test); assert Pod, Deployment, StatefulSet, DaemonSet, Job, PodGroup → present; Service, CronJob, ConfigMap → absent. Mock `../exec/TerminalTab` with a stub (`vi.mock("../exec/TerminalTab", () => ({ TerminalTab: () => <div>terminal</div> }))`) and assert clicking the tab renders it.

Run: `pnpm test -- src/features/details/DetailsPanel` → the new test fails.

- [ ] **Step 2: Implement**

`src/app/store.ts`:

```ts
export type DetailsTab = "overview" | "yaml" | "events" | "logs" | "terminal" | "history";
```

`src/features/details/DetailsPanel.tsx`:

```tsx
import { TerminalTab } from "../exec/TerminalTab";
// …
/** Kinds with running containers to open a shell in (spec §3 "Open"). */
const EXEC_KINDS: ReadonlySet<Kind> = new Set<Kind>(["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "PodGroup"]);
// … where the tabs are built, right after the Logs push:
  if (heading?.kind && EXEC_KINDS.has(heading.kind)) tabs.push({ id: "terminal", label: "Terminal" });
// … in the content switch, after the logs branch:
        ) : tab === "terminal" ? (
          <TerminalTab key={details.nodeId} nodeId={details.nodeId} />
```

(`key` remounts the tab on a new selection, which ends the session — spec §3 "End".)

- [ ] **Step 3: Run** — `pnpm typecheck && pnpm test` → green.

- [ ] **Step 4: Commit**

```bash
git add src/app/store.ts src/features/details/DetailsPanel.tsx src/features/details/DetailsPanel.test.tsx
git commit -m "$(cat <<'EOF'
Show the Terminal tab for pods and pod-running workloads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 12: README, full checks, live check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document** — in `README.md`, after the **Logs.** bullet list (after "- ANSI colours are rendered."), add:

```markdown
**Terminal.** Pods and workloads (Deployment, StatefulSet, DaemonSet, Job and pod groups) get a **Terminal** tab: pick the pod and container, then **Connect** to open a shell in it (`bash` when the image has it, otherwise `sh`). It is a full terminal — colours, cursor keys, resizing with the panel, copy with ⌘C / Ctrl+Shift+C. The session ends with `exit`, **Disconnect**, or when you select something else. Images without a shell (distroless) say so.
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

Expected: all green (the smoke only against the local `docker-desktop` context). Also `cd .. && rtk proxy pnpm build` and confirm the build output has xterm in a separate chunk (a `terminal-*.js` file under `dist/assets/`), not in `index-*.js`.

- [ ] **Step 3: Live check** — `pnpm tauri dev` (or a `pnpm tauri build --debug --bundles app` bundle), namespace `shop`:
1. Select Deployment `web` → **Terminal** → pick a pod → **Connect** → `ls /`, colours from `ls --color` (if available), arrow-key history, `top` resizes with the panel.
2. Escape, ⌘K inside the terminal reach the shell, not the app; clicking the graph and pressing Escape still deselects.
3. `exit 3` → `[session ended (exit code 3)]` and **Reconnect**.
4. Select `db`-like shell-less pod (none in `shop`; use the smoke's pause image or skip) → the no-shell message.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Document the Terminal tab in the README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

## Self-review

- **Spec coverage:** §3 Open (Task 2 targets, Task 10 pickers, explicit Connect), Shell (Task 1 `SHELL`, Task 9 xterm options: monospace, theme, 5 000 lines, fit), End (Task 4 ended/stop, Task 9 `endLine`, Task 11 `key` remount, Task 5 `stop_watchers`), Errors (Task 3, as terminal lines via Task 9), Keys (Task 10 stopPropagation, Task 9 copy handler). §4 commands and messages (Tasks 1, 4, 5, 6), lifecycle with the namespace session (Task 5), nothing logged (no `tracing` of data anywhere). §5 lazy xterm (Tasks 9–10), DetailsPanel tab (Task 11). §6 tests in every task; smoke (Task 7).
- **Placeholders:** none; Task 11 Step 1 points at the existing seeding helper in `DetailsPanel.test.tsx` because its exact name must match that file.
- **Type consistency:** `ExecMessage`/`ExecPod`/`ExecRequest` names and fields match across Rust (`session_id`, camelCase on the wire), TS types, fixtures and commands; `ExecSessions::{start,input,resize,stop,stop_all}` match the `Session` methods; `TermHandle` members used by `TerminalTab` and the test fake match `terminal.ts`.

## Deviations from the spec

1. **Pod and container options come from a new `exec_pods` command** (computed from the cached store), not from parsing the object's YAML in the frontend — a workload's YAML does not list its pods, and the backend already knows which are Running.
2. **`ExecMessage` carries `sessionId`**, like `LogMessage`, so a late message from a replaced session can be told apart.
3. **`start_exec` returns at once and connects inside the session task.** Only validation errors reject the command; permission, timeout and no-shell problems arrive as `error` / `ended` messages. This keeps the Tauri session lock from being held while the websocket opens (the port-forward review's lesson) and matches "errors are lines in the terminal".
4. **App shortcuts are kept out by stopping `keydown` propagation at the terminal element**, not by a check inside `useGlobalKeys`; it covers every window-level shortcut (Escape, ⌘K, ⌘S) with one listener.
5. **The connector module is `exec/remote.rs`**, not `exec/kube.rs`, so `kube::` paths inside the module keep meaning the crate.
