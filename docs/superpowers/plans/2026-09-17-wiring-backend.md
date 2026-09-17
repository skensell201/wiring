# Wiring Backend (Rust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Rust side of Wiring — kubeconfig discovery, a live Kubernetes session with watchers, a pure graph builder that turns cached objects into nodes/edges with statuses, a delta diff, and the Tauri command/event layer — fully unit-tested on YAML fixtures, plus a headless smoke test against a real cluster.

**Architecture:** The backend caches every watched object of one namespace in a `Store`, rebuilds the relationship `Graph` on every change (debounced 150 ms), diffs it against the previous graph, and pushes `GraphDelta` events to the frontend. `graph::*` is pure and synchronous; `session` owns the async watchers and emits through an `Emitter` trait so it can be tested without Tauri.

**Tech Stack:** Rust stable, Tauri 2.11, `kube` 4.2 (`client`, `runtime`, `rustls-tls`, `oauth`, `oidc`), `k8s-openapi` 0.28 (`v1_36`), `tokio`, `serde`/`serde_json`, `serde_yaml_ng`, `thiserror`, `tracing`, `tauri-plugin-store`, `tauri-plugin-dialog`.

**Spec:** `docs/superpowers/specs/2026-09-17-wiring-mvp-design.md`. The frontend has its own plan (written after this one lands).

---

## File structure

```
wiring/
  package.json                     pnpm scripts (tauri dev/build)
  src/                             React app — scaffold only in this plan
  src/shared/ipc/fixtures/*.json   IPC payload fixtures (checked by Rust test)
  src-tauri/
    Cargo.toml
    tauri.conf.json
    capabilities/default.json
    build.rs
    src/main.rs                    calls wiring_lib::run()
    src/lib.rs                     Tauri builder, plugin + command registration
    src/error.rs                   AppError { kind, message } + From<kube::Error>
    src/kubeconfig.rs              ContextInfo, list_contexts(paths)
    src/store/mod.rs               Kind, ObjectKey, Object enum, Store
    src/store/yaml.rs              Store::from_yaml_docs (fixtures + tests)
    src/graph/mod.rs               re-exports: build, diff, model types
    src/graph/model.rs             NodeId, Status, Node, Edge, Relation, Graph, GraphDelta
    src/graph/status.rs            per-kind (Status, badges) + summary key/values
    src/graph/relations.rs         edge derivation (owners, selectors, ingress, mounts, PVC/PV, SA, HPA)
    src/graph/build.rs             build(): nodes + edges, RS hiding, PodGroup collapse
    src/graph/diff.rs              diff(old, new) -> GraphDelta
    src/session/mod.rs             Session: connect, select_namespace, get_object, watch_events
    src/session/emitter.rs         Emitter trait, OutEvent enum, ChannelEmitter (tests)
    src/session/watch.rs           spawn_watch<K>() + StoreEvent
    src/session/reducer.rs         event loop: apply → debounce → build → diff → emit
    src/commands.rs                Tauri commands + TauriEmitter
    tests/fixtures/*.yaml          multi-document YAML fixtures
    tests/smoke.rs                 #[ignore] headless test against a real cluster
```

Each `graph/*` file is pure (no async, no kube client). `session/*` is the only place that talks to a cluster.

---

### Task 0: Toolchain

**Files:** none (machine setup)

- [ ] **Step 1: Install Rust**

Run:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"
rustc --version && cargo --version
```
Expected: `rustc 1.9x.x` and `cargo 1.9x.x`.

- [ ] **Step 2: Install pnpm and Tauri CLI**

Run:
```bash
npm install -g pnpm@9
pnpm --version
cargo install tauri-cli --version "^2" --locked
cargo tauri --version
```
Expected: `9.x.x` and `tauri-cli 2.x.x`.

- [ ] **Step 3: Verify Xcode CLT (macOS)**

Run: `xcode-select -p`
Expected: `/Applications/Xcode.app/Contents/Developer` (already present on this machine).

---

### Task 1: Scaffold the Tauri app

**Files:**
- Create: everything under `wiring/` via the template, then edit `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`.

- [ ] **Step 1: Generate the template into the existing repo**

Run (from `/Users/skensel/WORKING/AI`):
```bash
cd /Users/skensel/WORKING/AI
pnpm create tauri-app@latest wiring-scaffold --template react-ts --manager pnpm --yes
rsync -a --exclude .git wiring-scaffold/ wiring/
rm -rf wiring-scaffold
cd wiring && git status --short | head
```
Expected: new files `package.json`, `src/`, `src-tauri/`, `index.html`, `vite.config.ts`, etc. The existing `.gitignore` and `docs/` stay.

- [ ] **Step 2: Set identifiers and window**

Replace `src-tauri/tauri.conf.json` with:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Wiring",
  "version": "0.1.0",
  "identifier": "dev.wiring.app",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Wiring",
        "width": 1400,
        "height": 900,
        "minWidth": 960,
        "minHeight": 600,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true,
        "backgroundColor": "#0e0918"
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]
  }
}
```

- [ ] **Step 3: Set Cargo dependencies**

Replace `src-tauri/Cargo.toml` with:
```toml
[package]
name = "wiring"
version = "0.1.0"
description = "Kubernetes IDE with a live relationship graph"
edition = "2021"

[lib]
name = "wiring_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2.11", features = [] }
tauri-plugin-store = "2"
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order"] }
serde_yaml_ng = "0.10"
thiserror = "2"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time"] }
futures = "0.3"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
kube = { version = "4.2", default-features = false, features = ["client", "runtime", "rustls-tls", "oauth", "oidc", "config"] }
k8s-openapi = { version = "0.28", features = ["v1_36"] }
dirs = "6"

[dev-dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "time", "process"] }
```

- [ ] **Step 4: Minimal lib.rs / main.rs**

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    wiring_lib::run()
}
```

`src-tauri/src/lib.rs`:
```rust
pub mod error;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`src-tauri/src/error.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Auth,
    Network,
    Forbidden,
    NotFound,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{kind:?}: {message}")]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

- [ ] **Step 5: Build and run the empty app**

Run:
```bash
cd /Users/skensel/WORKING/AI/wiring && pnpm install && pnpm build && cd src-tauri && cargo build 2>&1 | tail -3
```
Expected: `Finished` with no errors (first build takes several minutes). `pnpm build` runs first because `tauri::generate_context!()` refuses to compile when `frontendDist` (`../dist`) does not exist.

Run: `cd /Users/skensel/WORKING/AI/wiring && pnpm tauri dev` — a dark window titled Wiring opens with the template page. Close it (Ctrl+C).

- [ ] **Step 6: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring
git add -A
git commit -m "Scaffold Tauri 2 + React app with kube-rs dependencies"
```

---

### Task 2: `Kind`, `ObjectKey`, `Object`, `Store`

**Files:**
- Create: `src-tauri/src/store/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod store;`)

- [ ] **Step 1: Write the failing tests** (at the bottom of `src-tauri/src/store/mod.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::Pod;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

    fn pod(ns: &str, name: &str) -> Object {
        Object::Pod(Pod {
            metadata: ObjectMeta { name: Some(name.into()), namespace: Some(ns.into()), ..Default::default() },
            ..Default::default()
        })
    }

    #[test]
    fn kind_round_trips_through_str() {
        for k in Kind::WATCHED {
            assert_eq!(Kind::parse(k.as_str()), Some(k));
        }
        assert_eq!(Kind::parse("Nope"), None);
    }

    #[test]
    fn object_key_uses_kind_namespace_name() {
        let key = pod("payments", "web-1").key();
        assert_eq!(key, ObjectKey { kind: Kind::Pod, namespace: Some("payments".into()), name: "web-1".into() });
    }

    #[test]
    fn store_upsert_get_remove() {
        let mut store = Store::default();
        store.upsert(pod("payments", "web-1"));
        store.upsert(pod("payments", "web-1")); // idempotent
        store.upsert(pod("payments", "web-2"));
        assert_eq!(store.len(), 2);
        let key = pod("payments", "web-1").key();
        assert!(store.get(&key).is_some());
        store.remove(&key);
        assert!(store.get(&key).is_none());
        assert_eq!(store.iter_kind(Kind::Pod).count(), 1);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test store:: 2>&1 | tail -5`
Expected: compile error — `store` module does not exist.

- [ ] **Step 3: Implement**

`src-tauri/src/store/mod.rs`:
```rust
//! In-memory cache of Kubernetes objects for the selected namespace.
//! Pure data — no async, no client.

pub mod yaml;

use std::collections::HashMap;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service, ServiceAccount,
};
use k8s_openapi::api::networking::v1::Ingress;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Kind {
    Deployment,
    StatefulSet,
    DaemonSet,
    ReplicaSet,
    Job,
    CronJob,
    Pod,
    Service,
    Ingress,
    ConfigMap,
    Secret,
    PersistentVolumeClaim,
    PersistentVolume,
    ServiceAccount,
    HorizontalPodAutoscaler,
    /// Synthetic node kind: a collapsed group of pods. Never stored.
    PodGroup,
}

impl Kind {
    pub const WATCHED: [Kind; 15] = [
        Kind::Deployment,
        Kind::StatefulSet,
        Kind::DaemonSet,
        Kind::ReplicaSet,
        Kind::Job,
        Kind::CronJob,
        Kind::Pod,
        Kind::Service,
        Kind::Ingress,
        Kind::ConfigMap,
        Kind::Secret,
        Kind::PersistentVolumeClaim,
        Kind::PersistentVolume,
        Kind::ServiceAccount,
        Kind::HorizontalPodAutoscaler,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Deployment => "Deployment",
            Kind::StatefulSet => "StatefulSet",
            Kind::DaemonSet => "DaemonSet",
            Kind::ReplicaSet => "ReplicaSet",
            Kind::Job => "Job",
            Kind::CronJob => "CronJob",
            Kind::Pod => "Pod",
            Kind::Service => "Service",
            Kind::Ingress => "Ingress",
            Kind::ConfigMap => "ConfigMap",
            Kind::Secret => "Secret",
            Kind::PersistentVolumeClaim => "PersistentVolumeClaim",
            Kind::PersistentVolume => "PersistentVolume",
            Kind::ServiceAccount => "ServiceAccount",
            Kind::HorizontalPodAutoscaler => "HorizontalPodAutoscaler",
            Kind::PodGroup => "PodGroup",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        Kind::WATCHED.iter().copied().find(|k| k.as_str() == s)
    }

    pub fn is_cluster_scoped(self) -> bool {
        matches!(self, Kind::PersistentVolume)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ObjectKey {
    pub kind: Kind,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone)]
pub enum Object {
    Deployment(Deployment),
    StatefulSet(StatefulSet),
    DaemonSet(DaemonSet),
    ReplicaSet(ReplicaSet),
    Job(Job),
    CronJob(CronJob),
    Pod(Pod),
    Service(Service),
    Ingress(Ingress),
    ConfigMap(ConfigMap),
    Secret(Secret),
    PersistentVolumeClaim(PersistentVolumeClaim),
    PersistentVolume(PersistentVolume),
    ServiceAccount(ServiceAccount),
    HorizontalPodAutoscaler(HorizontalPodAutoscaler),
}

macro_rules! for_each_object {
    ($self:expr, $o:ident => $body:expr) => {
        match $self {
            Object::Deployment($o) => $body,
            Object::StatefulSet($o) => $body,
            Object::DaemonSet($o) => $body,
            Object::ReplicaSet($o) => $body,
            Object::Job($o) => $body,
            Object::CronJob($o) => $body,
            Object::Pod($o) => $body,
            Object::Service($o) => $body,
            Object::Ingress($o) => $body,
            Object::ConfigMap($o) => $body,
            Object::Secret($o) => $body,
            Object::PersistentVolumeClaim($o) => $body,
            Object::PersistentVolume($o) => $body,
            Object::ServiceAccount($o) => $body,
            Object::HorizontalPodAutoscaler($o) => $body,
        }
    };
}
pub(crate) use for_each_object;

impl Object {
    pub fn kind(&self) -> Kind {
        match self {
            Object::Deployment(_) => Kind::Deployment,
            Object::StatefulSet(_) => Kind::StatefulSet,
            Object::DaemonSet(_) => Kind::DaemonSet,
            Object::ReplicaSet(_) => Kind::ReplicaSet,
            Object::Job(_) => Kind::Job,
            Object::CronJob(_) => Kind::CronJob,
            Object::Pod(_) => Kind::Pod,
            Object::Service(_) => Kind::Service,
            Object::Ingress(_) => Kind::Ingress,
            Object::ConfigMap(_) => Kind::ConfigMap,
            Object::Secret(_) => Kind::Secret,
            Object::PersistentVolumeClaim(_) => Kind::PersistentVolumeClaim,
            Object::PersistentVolume(_) => Kind::PersistentVolume,
            Object::ServiceAccount(_) => Kind::ServiceAccount,
            Object::HorizontalPodAutoscaler(_) => Kind::HorizontalPodAutoscaler,
        }
    }

    pub fn meta(&self) -> &ObjectMeta {
        for_each_object!(self, o => &o.metadata)
    }

    pub fn meta_mut(&mut self) -> &mut ObjectMeta {
        for_each_object!(self, o => &mut o.metadata)
    }

    pub fn name(&self) -> &str {
        self.meta().name.as_deref().unwrap_or_default()
    }

    pub fn namespace(&self) -> Option<&str> {
        self.meta().namespace.as_deref()
    }

    pub fn uid(&self) -> Option<&str> {
        self.meta().uid.as_deref()
    }

    pub fn key(&self) -> ObjectKey {
        ObjectKey {
            kind: self.kind(),
            namespace: self.namespace().map(str::to_owned),
            name: self.name().to_owned(),
        }
    }

    /// Serialize to JSON with server-side noise (managedFields) removed.
    pub fn to_json_value(&self) -> serde_json::Value {
        let mut clone = self.clone();
        clone.meta_mut().managed_fields = None;
        for_each_object!(&clone, o => serde_json::to_value(o).unwrap_or(serde_json::Value::Null))
    }
}

#[derive(Debug, Default, Clone)]
pub struct Store {
    objects: HashMap<ObjectKey, Object>,
}

impl Store {
    pub fn upsert(&mut self, obj: Object) {
        self.objects.insert(obj.key(), obj);
    }

    pub fn remove(&mut self, key: &ObjectKey) -> Option<Object> {
        self.objects.remove(key)
    }

    pub fn get(&self, key: &ObjectKey) -> Option<&Object> {
        self.objects.get(key)
    }

    pub fn len(&self) -> usize {
        self.objects.len()
    }

    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Object> {
        self.objects.values()
    }

    pub fn iter_kind(&self, kind: Kind) -> impl Iterator<Item = &Object> {
        self.objects.values().filter(move |o| o.kind() == kind)
    }

    /// Look up by kind + namespace + name; `namespace` is ignored for cluster-scoped kinds.
    pub fn find(&self, kind: Kind, namespace: Option<&str>, name: &str) -> Option<&Object> {
        let ns = if kind.is_cluster_scoped() { None } else { namespace.map(str::to_owned) };
        self.objects.get(&ObjectKey { kind, namespace: ns, name: name.to_owned() })
    }
}
```

Add `pub mod store;` to `src-tauri/src/lib.rs` (below `pub mod error;`). Create an empty `src-tauri/src/store/yaml.rs` containing only `//! YAML loading — implemented in Task 3.`

- [ ] **Step 4: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test store:: 2>&1 | tail -5`
Expected: `test result: ok. 3 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Add Kind, Object and Store cache types"
```

---

### Task 3: Load multi-document YAML fixtures into a `Store`

**Files:**
- Create: `src-tauri/src/store/yaml.rs`
- Create: `src-tauri/tests/fixtures/deployment-basic.yaml`

- [ ] **Step 1: Write the fixture** `src-tauri/tests/fixtures/deployment-basic.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: payments
  uid: dep-web
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginx:1.27
status:
  replicas: 2
  readyReplicas: 2
  availableReplicas: 2
  conditions:
    - type: Progressing
      status: "True"
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-7f9c
  namespace: payments
  uid: rs-web-7f9c
  ownerReferences:
    - apiVersion: apps/v1
      kind: Deployment
      name: web
      uid: dep-web
      controller: true
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginx:1.27
status:
  replicas: 2
  readyReplicas: 2
---
apiVersion: v1
kind: Pod
metadata:
  name: web-7f9c-aaaaa
  namespace: payments
  uid: pod-a
  labels: { app: web }
  ownerReferences:
    - apiVersion: apps/v1
      kind: ReplicaSet
      name: web-7f9c
      uid: rs-web-7f9c
      controller: true
spec:
  containers:
    - name: web
      image: nginx:1.27
status:
  phase: Running
  containerStatuses:
    - name: web
      ready: true
      restartCount: 0
      image: nginx:1.27
      imageID: ""
      state: { running: { startedAt: "2026-09-17T10:00:00Z" } }
---
apiVersion: v1
kind: Pod
metadata:
  name: web-7f9c-bbbbb
  namespace: payments
  uid: pod-b
  labels: { app: web }
  ownerReferences:
    - apiVersion: apps/v1
      kind: ReplicaSet
      name: web-7f9c
      uid: rs-web-7f9c
      controller: true
spec:
  containers:
    - name: web
      image: nginx:1.27
status:
  phase: Running
  containerStatuses:
    - name: web
      ready: true
      restartCount: 0
      image: nginx:1.27
      imageID: ""
      state: { running: { startedAt: "2026-09-17T10:00:00Z" } }
```

- [ ] **Step 2: Write the failing test** (bottom of `src-tauri/src/store/yaml.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Kind;

    #[test]
    fn loads_every_document_by_kind() {
        let store = Store::from_fixture("deployment-basic").unwrap();
        assert_eq!(store.len(), 4);
        assert_eq!(store.iter_kind(Kind::Deployment).count(), 1);
        assert_eq!(store.iter_kind(Kind::ReplicaSet).count(), 1);
        assert_eq!(store.iter_kind(Kind::Pod).count(), 2);
        let dep = store.find(Kind::Deployment, Some("payments"), "web").unwrap();
        assert_eq!(dep.uid(), Some("dep-web"));
    }

    #[test]
    fn unknown_kind_is_an_error() {
        let err = Store::from_yaml_docs("apiVersion: v1\nkind: Node\nmetadata:\n  name: n1\n").unwrap_err();
        assert!(err.contains("Node"), "{err}");
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test store::yaml 2>&1 | tail -5`
Expected: compile error — `from_fixture` / `from_yaml_docs` not found.

- [ ] **Step 4: Implement** `src-tauri/src/store/yaml.rs`

```rust
//! Build a `Store` from multi-document YAML. Used by tests and fixtures.

use super::{Kind, Object, Store};
use serde::Deserialize;

impl Object {
    /// Deserialize one document whose `kind` field selects the variant.
    pub fn from_json_value(value: serde_json::Value) -> Result<Object, String> {
        let kind_str = value
            .get("kind")
            .and_then(|k| k.as_str())
            .ok_or_else(|| "document has no `kind`".to_string())?;
        let kind = Kind::parse(kind_str).ok_or_else(|| format!("unsupported kind `{kind_str}`"))?;
        macro_rules! de {
            ($variant:ident) => {
                serde_json::from_value(value.clone())
                    .map(Object::$variant)
                    .map_err(|e| format!("{kind_str}: {e}"))
            };
        }
        match kind {
            Kind::Deployment => de!(Deployment),
            Kind::StatefulSet => de!(StatefulSet),
            Kind::DaemonSet => de!(DaemonSet),
            Kind::ReplicaSet => de!(ReplicaSet),
            Kind::Job => de!(Job),
            Kind::CronJob => de!(CronJob),
            Kind::Pod => de!(Pod),
            Kind::Service => de!(Service),
            Kind::Ingress => de!(Ingress),
            Kind::ConfigMap => de!(ConfigMap),
            Kind::Secret => de!(Secret),
            Kind::PersistentVolumeClaim => de!(PersistentVolumeClaim),
            Kind::PersistentVolume => de!(PersistentVolume),
            Kind::ServiceAccount => de!(ServiceAccount),
            Kind::HorizontalPodAutoscaler => de!(HorizontalPodAutoscaler),
            Kind::PodGroup => Err("PodGroup is synthetic and cannot be loaded".into()),
        }
    }
}

impl Store {
    pub fn from_yaml_docs(yaml: &str) -> Result<Store, String> {
        let mut store = Store::default();
        for doc in serde_yaml_ng::Deserializer::from_str(yaml) {
            let value = serde_json::Value::deserialize(doc).map_err(|e| e.to_string())?;
            if value.is_null() {
                continue;
            }
            store.upsert(Object::from_json_value(value)?);
        }
        Ok(store)
    }

    /// Load `tests/fixtures/<name>.yaml` relative to the crate root.
    pub fn from_fixture(name: &str) -> Result<Store, String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(format!("{name}.yaml"));
        let yaml = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Store::from_yaml_docs(&yaml)
    }
}
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test store:: 2>&1 | tail -5`
Expected: `test result: ok. 5 passed`.

- [ ] **Step 6: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Load multi-document YAML fixtures into Store"
```

---

### Task 4: Graph model types

**Files:**
- Create: `src-tauri/src/graph/mod.rs`, `src-tauri/src/graph/model.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod graph;`)

- [ ] **Step 1: Write the failing tests** (bottom of `src-tauri/src/graph/model.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Kind;

    #[test]
    fn node_id_formats_namespaced_and_cluster_scoped() {
        assert_eq!(node_id(Kind::Pod, Some("payments"), "web-1"), "Pod/payments/web-1");
        assert_eq!(node_id(Kind::PersistentVolume, None, "pv-1"), "PersistentVolume//pv-1");
    }

    #[test]
    fn edge_id_is_source_target_relation() {
        let e = Edge::new("Service/p/svc", "Pod/p/a", Relation::Selects);
        assert_eq!(e.id, "Service/p/svc->Pod/p/a:selects");
    }

    #[test]
    fn serializes_with_camel_case_and_lowercase_enums() {
        let n = Node {
            id: "Pod/p/a".into(),
            kind: Kind::Pod,
            namespace: Some("p".into()),
            name: "a".into(),
            status: Status::Err,
            badges: vec!["CrashLoopBackOff".into()],
            group: None,
        };
        let json = serde_json::to_value(&n).unwrap();
        assert_eq!(json["status"], "err");
        assert_eq!(json["kind"], "Pod");
        assert!(json["group"].is_null());
        let e = Edge::new("a", "b", Relation::UsesSa);
        assert_eq!(serde_json::to_value(&e).unwrap()["relation"], "usesSA");
    }

    #[test]
    fn status_worst_ordering() {
        assert_eq!(Status::Ok.max(Status::Warn), Status::Warn);
        assert_eq!(Status::Err.max(Status::Unknown), Status::Err);
        assert_eq!(Status::Unknown.max(Status::Ok), Status::Ok);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph::model 2>&1 | tail -5`
Expected: compile error — module `graph` not found.

- [ ] **Step 3: Implement**

`src-tauri/src/graph/mod.rs`:
```rust
//! Pure graph construction: Store -> Graph, Graph x Graph -> GraphDelta.

pub mod model;

pub use model::*;
```

`src-tauri/src/graph/model.rs`:
```rust
use serde::{Deserialize, Serialize};

use crate::store::Kind;

pub type NodeId = String;

/// Ordered so that `max()` yields the worst status: Unknown < Ok < Warn < Err.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Unknown,
    Ok,
    Warn,
    Err,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupInfo {
    pub count: usize,
    pub ok: usize,
    pub warn: usize,
    pub err: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: NodeId,
    pub kind: Kind,
    pub namespace: Option<String>,
    pub name: String,
    pub status: Status,
    pub badges: Vec<String>,
    pub group: Option<GroupInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Relation {
    #[serde(rename = "owns")]
    Owns,
    #[serde(rename = "selects")]
    Selects,
    #[serde(rename = "routes")]
    Routes,
    #[serde(rename = "mounts")]
    Mounts,
    #[serde(rename = "envFrom")]
    EnvFrom,
    #[serde(rename = "claims")]
    Claims,
    #[serde(rename = "binds")]
    Binds,
    #[serde(rename = "usesSA")]
    UsesSa,
    #[serde(rename = "scales")]
    Scales,
}

impl Relation {
    pub fn as_str(self) -> &'static str {
        match self {
            Relation::Owns => "owns",
            Relation::Selects => "selects",
            Relation::Routes => "routes",
            Relation::Mounts => "mounts",
            Relation::EnvFrom => "envFrom",
            Relation::Claims => "claims",
            Relation::Binds => "binds",
            Relation::UsesSa => "usesSA",
            Relation::Scales => "scales",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub source: NodeId,
    pub target: NodeId,
    pub relation: Relation,
}

impl Edge {
    pub fn new(source: impl Into<NodeId>, target: impl Into<NodeId>, relation: Relation) -> Edge {
        let source = source.into();
        let target = target.into();
        Edge { id: format!("{source}->{target}:{}", relation.as_str()), source, target, relation }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

impl Graph {
    /// Sort nodes and edges by id and drop duplicate edges, so equal graphs compare equal.
    pub fn normalize(&mut self) {
        self.nodes.sort_by(|a, b| a.id.cmp(&b.id));
        self.edges.sort_by(|a, b| a.id.cmp(&b.id));
        self.edges.dedup_by(|a, b| a.id == b.id);
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn edges_touching<'a>(&'a self, id: &'a str) -> impl Iterator<Item = &'a Edge> + 'a {
        self.edges.iter().filter(move |e| e.source == id || e.target == id)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDelta {
    pub added_nodes: Vec<Node>,
    pub updated_nodes: Vec<Node>,
    pub removed_nodes: Vec<NodeId>,
    pub added_edges: Vec<Edge>,
    pub removed_edges: Vec<String>,
}

impl GraphDelta {
    pub fn is_empty(&self) -> bool {
        self.added_nodes.is_empty()
            && self.updated_nodes.is_empty()
            && self.removed_nodes.is_empty()
            && self.added_edges.is_empty()
            && self.removed_edges.is_empty()
    }
}

pub fn node_id(kind: Kind, namespace: Option<&str>, name: &str) -> NodeId {
    format!("{}/{}/{}", kind.as_str(), namespace.unwrap_or(""), name)
}
```

Add `pub mod graph;` to `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph::model 2>&1 | tail -5`
Expected: `test result: ok. 4 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Add graph model types (Node, Edge, Graph, GraphDelta)"
```

---

### Task 5: Per-kind status, badges and summary

**Files:**
- Create: `src-tauri/src/graph/status.rs`
- Create: `src-tauri/tests/fixtures/statuses.yaml`
- Modify: `src-tauri/src/graph/mod.rs` (add `pub mod status;`)

- [ ] **Step 1: Write the fixture** `src-tauri/tests/fixtures/statuses.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: healthy, namespace: s }
spec:
  replicas: 3
  selector: { matchLabels: { app: healthy } }
  template:
    metadata: { labels: { app: healthy } }
    spec: { containers: [ { name: c, image: nginx:1.27 } ] }
status: { replicas: 3, readyReplicas: 3, conditions: [ { type: Progressing, status: "True" } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: rolling, namespace: s }
spec:
  replicas: 3
  selector: { matchLabels: { app: rolling } }
  template:
    metadata: { labels: { app: rolling } }
    spec: { containers: [ { name: c, image: nginx:1.28 } ] }
status: { replicas: 3, readyReplicas: 2, conditions: [ { type: Progressing, status: "True" } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: stuck, namespace: s }
spec:
  replicas: 3
  selector: { matchLabels: { app: stuck } }
  template:
    metadata: { labels: { app: stuck } }
    spec: { containers: [ { name: c, image: nginx:bad } ] }
status: { replicas: 3, readyReplicas: 0, conditions: [ { type: Progressing, status: "False", reason: ProgressDeadlineExceeded } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: running, namespace: s }
spec: { containers: [ { name: c, image: nginx } ] }
status:
  phase: Running
  containerStatuses: [ { name: c, ready: true, restartCount: 0, image: nginx, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } } ]
---
apiVersion: v1
kind: Pod
metadata: { name: crashing, namespace: s }
spec: { containers: [ { name: c, image: nginx } ] }
status:
  phase: Running
  containerStatuses: [ { name: c, ready: false, restartCount: 14, image: nginx, imageID: "", state: { waiting: { reason: CrashLoopBackOff } } } ]
---
apiVersion: v1
kind: Pod
metadata: { name: pending, namespace: s }
spec: { containers: [ { name: c, image: nginx } ] }
status: { phase: Pending }
---
apiVersion: v1
kind: Pod
metadata: { name: notready, namespace: s }
spec: { containers: [ { name: c, image: nginx }, { name: d, image: nginx } ] }
status:
  phase: Running
  containerStatuses:
    - { name: c, ready: true, restartCount: 0, image: nginx, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } }
    - { name: d, ready: false, restartCount: 2, image: nginx, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } }
---
apiVersion: v1
kind: Pod
metadata: { name: oom, namespace: s }
spec: { containers: [ { name: c, image: nginx } ] }
status:
  phase: Running
  containerStatuses: [ { name: c, ready: false, restartCount: 3, image: nginx, imageID: "", state: { terminated: { reason: OOMKilled, exitCode: 137 } } } ]
---
apiVersion: v1
kind: Service
metadata: { name: matched, namespace: s }
spec: { type: ClusterIP, selector: { app: running }, ports: [ { port: 80, targetPort: 8080 } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: running-labelled, namespace: s, labels: { app: running } }
spec: { containers: [ { name: c, image: nginx } ] }
status: { phase: Running, containerStatuses: [ { name: c, ready: true, restartCount: 0, image: nginx, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } } ] }
---
apiVersion: v1
kind: Service
metadata: { name: orphan, namespace: s }
spec: { type: NodePort, selector: { app: nothing }, ports: [ { port: 443, targetPort: https } ] }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: multi, namespace: s }
spec:
  rules:
    - { host: a.example.com, http: { paths: [ { path: /, pathType: Prefix, backend: { service: { name: matched, port: { number: 80 } } } } ] } }
    - { host: b.example.com, http: { paths: [ { path: /, pathType: Prefix, backend: { service: { name: matched, port: { number: 80 } } } } ] } }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: cfg, namespace: s }
data: { a: "1", b: "2", c: "3" }
---
apiVersion: v1
kind: Secret
metadata: { name: tls, namespace: s }
type: kubernetes.io/tls
data: { tls.crt: "YQ==", tls.key: "Yg==" }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data, namespace: s }
spec: { accessModes: [ ReadWriteOnce ], storageClassName: fast, resources: { requests: { storage: 10Gi } } }
status: { phase: Bound }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: waiting, namespace: s }
spec: { accessModes: [ ReadWriteOnce ], resources: { requests: { storage: 1Gi } } }
status: { phase: Pending }
---
apiVersion: v1
kind: PersistentVolume
metadata: { name: pv-1 }
spec: { capacity: { storage: 10Gi }, persistentVolumeReclaimPolicy: Retain, accessModes: [ ReadWriteOnce ] }
---
apiVersion: batch/v1
kind: Job
metadata: { name: ok-job, namespace: s }
spec: { completions: 2, template: { spec: { containers: [ { name: c, image: busybox } ], restartPolicy: Never } } }
status: { succeeded: 2, conditions: [ { type: Complete, status: "True" } ] }
---
apiVersion: batch/v1
kind: Job
metadata: { name: failed-job, namespace: s }
spec: { completions: 1, template: { spec: { containers: [ { name: c, image: busybox } ], restartPolicy: Never } } }
status: { failed: 1, conditions: [ { type: Failed, status: "True" } ] }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly, namespace: s }
spec: { schedule: "0 2 * * *", suspend: true, jobTemplate: { spec: { template: { spec: { containers: [ { name: c, image: busybox } ], restartPolicy: Never } } } } }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: web-hpa, namespace: s }
spec: { minReplicas: 2, maxReplicas: 10, scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: healthy } }
status: { currentReplicas: 3, desiredReplicas: 3, conditions: [ { type: ScalingLimited, status: "True", reason: TooFewReplicas } ] }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: web-sa, namespace: s }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db, namespace: s }
spec:
  replicas: 3
  serviceName: db
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec: { containers: [ { name: c, image: postgres:16 } ] }
status: { replicas: 3, readyReplicas: 3 }
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: agent, namespace: s }
spec:
  selector: { matchLabels: { app: agent } }
  template:
    metadata: { labels: { app: agent } }
    spec: { containers: [ { name: c, image: agent:2 } ] }
status: { desiredNumberScheduled: 4, numberReady: 3, currentNumberScheduled: 4, numberMisscheduled: 0 }
```

- [ ] **Step 2: Write the failing tests** (bottom of `src-tauri/src/graph/status.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Kind, Store};

    fn describe_named(store: &Store, kind: Kind, name: &str) -> (Status, Vec<String>) {
        let obj = store.find(kind, Some("s"), name).or_else(|| store.find(kind, None, name)).unwrap();
        describe(obj, store)
    }

    #[test]
    fn deployment_statuses() {
        let s = Store::from_fixture("statuses").unwrap();
        assert_eq!(describe_named(&s, Kind::Deployment, "healthy"), (Status::Ok, vec!["3/3".into(), "nginx:1.27".into()]));
        assert_eq!(describe_named(&s, Kind::Deployment, "rolling").0, Status::Warn);
        assert_eq!(describe_named(&s, Kind::Deployment, "stuck").0, Status::Err);
        assert_eq!(describe_named(&s, Kind::StatefulSet, "db"), (Status::Ok, vec!["3/3".into(), "postgres:16".into()]));
        assert_eq!(describe_named(&s, Kind::DaemonSet, "agent"), (Status::Warn, vec!["3/4".into(), "agent:2".into()]));
    }

    #[test]
    fn pod_statuses() {
        let s = Store::from_fixture("statuses").unwrap();
        assert_eq!(describe_named(&s, Kind::Pod, "running"), (Status::Ok, vec!["Running".into()]));
        assert_eq!(describe_named(&s, Kind::Pod, "crashing"), (Status::Err, vec!["CrashLoopBackOff".into(), "↻ 14".into()]));
        assert_eq!(describe_named(&s, Kind::Pod, "pending"), (Status::Warn, vec!["Pending".into()]));
        assert_eq!(describe_named(&s, Kind::Pod, "notready"), (Status::Warn, vec!["Running".into(), "↻ 2".into()]));
        assert_eq!(describe_named(&s, Kind::Pod, "oom"), (Status::Err, vec!["OOMKilled".into(), "↻ 3".into()]));
    }

    #[test]
    fn service_warns_when_selector_matches_nothing() {
        let s = Store::from_fixture("statuses").unwrap();
        assert_eq!(describe_named(&s, Kind::Service, "matched"), (Status::Ok, vec!["ClusterIP".into(), "80→8080".into()]));
        assert_eq!(describe_named(&s, Kind::Service, "orphan"), (Status::Warn, vec!["NodePort".into(), "443→https".into()]));
    }

    #[test]
    fn config_storage_and_batch_badges() {
        let s = Store::from_fixture("statuses").unwrap();
        assert_eq!(describe_named(&s, Kind::Ingress, "multi"), (Status::Ok, vec!["a.example.com +1".into()]));
        assert_eq!(describe_named(&s, Kind::ConfigMap, "cfg"), (Status::Ok, vec!["3 keys".into()]));
        assert_eq!(describe_named(&s, Kind::Secret, "tls"), (Status::Ok, vec!["2 keys".into()]));
        assert_eq!(describe_named(&s, Kind::PersistentVolumeClaim, "data"), (Status::Ok, vec!["10Gi".into(), "fast".into()]));
        assert_eq!(describe_named(&s, Kind::PersistentVolumeClaim, "waiting"), (Status::Warn, vec!["1Gi".into()]));
        assert_eq!(describe_named(&s, Kind::PersistentVolume, "pv-1"), (Status::Ok, vec!["10Gi".into(), "Retain".into()]));
        assert_eq!(describe_named(&s, Kind::Job, "ok-job"), (Status::Ok, vec!["2/2".into()]));
        assert_eq!(describe_named(&s, Kind::Job, "failed-job"), (Status::Err, vec!["0/1".into()]));
        assert_eq!(describe_named(&s, Kind::CronJob, "nightly"), (Status::Warn, vec!["0 2 * * *".into()]));
        assert_eq!(describe_named(&s, Kind::HorizontalPodAutoscaler, "web-hpa"), (Status::Warn, vec!["2–10".into(), "3".into()]));
        assert_eq!(describe_named(&s, Kind::ServiceAccount, "web-sa"), (Status::Ok, vec![]));
    }

    #[test]
    fn summary_has_kind_specific_rows() {
        let s = Store::from_fixture("statuses").unwrap();
        let pod = s.find(Kind::Pod, Some("s"), "crashing").unwrap();
        let rows = summary(pod);
        assert!(rows.iter().any(|(k, v)| k == "Phase" && v == "Running"));
        assert!(rows.iter().any(|(k, v)| k == "Restarts" && v == "14"));
        let svc = s.find(Kind::Service, Some("s"), "matched").unwrap();
        let rows = summary(svc);
        assert!(rows.iter().any(|(k, v)| k == "Selector" && v == "app=running"));
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph::status 2>&1 | tail -5`
Expected: compile error — module `status` not found.

- [ ] **Step 4: Implement** `src-tauri/src/graph/status.rs`

```rust
//! Status colour, badges and Overview rows for every supported kind.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service,
};
use k8s_openapi::api::networking::v1::Ingress;

use super::model::Status;
use crate::store::{Object, Store};

pub type Badges = Vec<String>;
pub type SummaryRows = Vec<(String, String)>;

/// Status + badges shown on the node card.
pub fn describe(obj: &Object, store: &Store) -> (Status, Badges) {
    match obj {
        Object::Deployment(d) => deployment(d),
        Object::StatefulSet(s) => statefulset(s),
        Object::DaemonSet(d) => daemonset(d),
        Object::ReplicaSet(r) => replicaset(r),
        Object::Job(j) => job(j),
        Object::CronJob(c) => cronjob(c),
        Object::Pod(p) => pod(p),
        Object::Service(s) => service(s, store),
        Object::Ingress(i) => ingress(i),
        Object::ConfigMap(c) => (Status::Ok, vec![keys_badge(c.data.as_ref().map_or(0, |d| d.len()) + c.binary_data.as_ref().map_or(0, |d| d.len()))]),
        Object::Secret(s) => (Status::Ok, vec![keys_badge(s.data.as_ref().map_or(0, |d| d.len()) + s.string_data.as_ref().map_or(0, |d| d.len()))]),
        Object::PersistentVolumeClaim(p) => pvc(p),
        Object::PersistentVolume(p) => pv(p),
        Object::ServiceAccount(_) => (Status::Ok, vec![]),
        Object::HorizontalPodAutoscaler(h) => hpa(h),
    }
}

fn keys_badge(n: usize) -> String {
    format!("{n} keys")
}

fn ready_desired(ready: i32, desired: i32) -> String {
    format!("{ready}/{desired}")
}

fn first_image(containers: &[k8s_openapi::api::core::v1::Container]) -> Option<String> {
    containers.first().and_then(|c| c.image.clone())
}

fn condition_is<'a>(conds: impl IntoIterator<Item = (&'a str, &'a str)>, ty: &str, status: &str) -> bool {
    conds.into_iter().any(|(t, s)| t == ty && s == status)
}

fn workload_status(ready: i32, desired: i32, progressing_false: bool) -> Status {
    if ready < desired && progressing_false {
        Status::Err
    } else if ready < desired {
        Status::Warn
    } else {
        Status::Ok
    }
}

fn deployment(d: &Deployment) -> (Status, Badges) {
    let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let st = d.status.as_ref();
    let ready = st.and_then(|s| s.ready_replicas).unwrap_or(0);
    let progressing_false = st
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| condition_is(cs.iter().map(|c| (c.type_.as_str(), c.status.as_str())), "Progressing", "False"))
        .unwrap_or(false);
    let mut badges = vec![ready_desired(ready, desired)];
    if let Some(img) = d.spec.as_ref().and_then(|s| s.template.spec.as_ref()).and_then(|ps| first_image(&ps.containers)) {
        badges.push(img);
    }
    (workload_status(ready, desired, progressing_false), badges)
}

fn statefulset(s: &StatefulSet) -> (Status, Badges) {
    let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let ready = s.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
    let mut badges = vec![ready_desired(ready, desired)];
    if let Some(img) = s.spec.as_ref().and_then(|s| s.template.spec.as_ref()).and_then(|ps| first_image(&ps.containers)) {
        badges.push(img);
    }
    (workload_status(ready, desired, false), badges)
}

fn daemonset(d: &DaemonSet) -> (Status, Badges) {
    let st = d.status.as_ref();
    let desired = st.map(|s| s.desired_number_scheduled).unwrap_or(0);
    let ready = st.map(|s| s.number_ready).unwrap_or(0);
    let mut badges = vec![ready_desired(ready, desired)];
    if let Some(img) = d.spec.as_ref().and_then(|s| s.template.spec.as_ref()).and_then(|ps| first_image(&ps.containers)) {
        badges.push(img);
    }
    (workload_status(ready, desired, false), badges)
}

fn replicaset(r: &ReplicaSet) -> (Status, Badges) {
    let desired = r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let ready = r.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
    (workload_status(ready, desired, false), vec![ready_desired(ready, desired)])
}

fn job(j: &Job) -> (Status, Badges) {
    let completions = j.spec.as_ref().and_then(|s| s.completions).unwrap_or(1);
    let st = j.status.as_ref();
    let succeeded = st.and_then(|s| s.succeeded).unwrap_or(0);
    let failed = st
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| condition_is(cs.iter().map(|c| (c.type_.as_str(), c.status.as_str())), "Failed", "True"))
        .unwrap_or(false);
    let status = if failed { Status::Err } else if succeeded < completions { Status::Warn } else { Status::Ok };
    (status, vec![ready_desired(succeeded, completions)])
}

fn cronjob(c: &CronJob) -> (Status, Badges) {
    let spec = c.spec.as_ref();
    let schedule = spec.map(|s| s.schedule.clone()).unwrap_or_default();
    let suspended = spec.and_then(|s| s.suspend).unwrap_or(false);
    (if suspended { Status::Warn } else { Status::Ok }, vec![schedule])
}

const POD_ERR_REASONS: [&str; 5] = ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled", "Error"];

fn pod(p: &Pod) -> (Status, Badges) {
    let st = p.status.as_ref();
    let phase = st.and_then(|s| s.phase.clone()).unwrap_or_else(|| "Unknown".into());
    let statuses = st.and_then(|s| s.container_statuses.as_ref()).cloned().unwrap_or_default();
    let restarts: i32 = statuses.iter().map(|c| c.restart_count).sum();
    let all_ready = !statuses.is_empty() && statuses.iter().all(|c| c.ready);

    // A waiting/terminated reason is more informative than the phase.
    let reason = statuses.iter().find_map(|c| {
        let state = c.state.as_ref()?;
        state
            .waiting
            .as_ref()
            .and_then(|w| w.reason.clone())
            .or_else(|| state.terminated.as_ref().and_then(|t| t.reason.clone()).filter(|r| r != "Completed"))
    });

    let label = reason.clone().unwrap_or_else(|| phase.clone());
    let status = if phase == "Failed" || reason.as_deref().map_or(false, |r| POD_ERR_REASONS.contains(&r)) {
        Status::Err
    } else if phase == "Succeeded" {
        Status::Ok
    } else if phase == "Pending" || phase == "Unknown" || !all_ready {
        Status::Warn
    } else {
        Status::Ok
    };

    let mut badges = vec![label];
    if restarts > 0 {
        badges.push(format!("↻ {restarts}"));
    }
    (status, badges)
}

/// True when every key/value of `selector` is present in `labels`. An empty selector matches nothing.
pub fn selector_matches(selector: &BTreeMap<String, String>, labels: Option<&BTreeMap<String, String>>) -> bool {
    if selector.is_empty() {
        return false;
    }
    let Some(labels) = labels else { return false };
    selector.iter().all(|(k, v)| labels.get(k) == Some(v))
}

fn service(s: &Service, store: &Store) -> (Status, Badges) {
    let spec = s.spec.as_ref();
    let ty = spec.and_then(|s| s.type_.clone()).unwrap_or_else(|| "ClusterIP".into());
    let mut badges = vec![ty];
    if let Some(port) = spec.and_then(|s| s.ports.as_ref()).and_then(|p| p.first()) {
        let target = match &port.target_port {
            Some(k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i)) => i.to_string(),
            Some(k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s)) => s.clone(),
            None => port.port.to_string(),
        };
        badges.push(format!("{}→{}", port.port, target));
    }
    let status = match spec.and_then(|s| s.selector.as_ref()) {
        // Headless/ExternalName services without a selector are not "orphans".
        None => Status::Ok,
        Some(sel) => {
            let ns = s.metadata.namespace.as_deref();
            let any = store
                .iter_kind(crate::store::Kind::Pod)
                .filter(|p| p.namespace() == ns)
                .any(|p| selector_matches(sel, p.meta().labels.as_ref()));
            if any { Status::Ok } else { Status::Warn }
        }
    };
    (status, badges)
}

fn ingress(i: &Ingress) -> (Status, Badges) {
    let hosts: Vec<String> = i
        .spec
        .as_ref()
        .and_then(|s| s.rules.as_ref())
        .map(|rules| rules.iter().filter_map(|r| r.host.clone()).collect())
        .unwrap_or_default();
    let badge = match hosts.len() {
        0 => None,
        1 => Some(hosts[0].clone()),
        n => Some(format!("{} +{}", hosts[0], n - 1)),
    };
    (Status::Ok, badge.into_iter().collect())
}

fn pvc(p: &PersistentVolumeClaim) -> (Status, Badges) {
    let spec = p.spec.as_ref();
    let mut badges = vec![];
    if let Some(size) = spec
        .and_then(|s| s.resources.as_ref())
        .and_then(|r| r.requests.as_ref())
        .and_then(|r| r.get("storage"))
    {
        badges.push(size.0.clone());
    }
    if let Some(sc) = spec.and_then(|s| s.storage_class_name.clone()) {
        badges.push(sc);
    }
    let pending = p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Pending");
    (if pending { Status::Warn } else { Status::Ok }, badges)
}

fn pv(p: &PersistentVolume) -> (Status, Badges) {
    let spec = p.spec.as_ref();
    let mut badges = vec![];
    if let Some(cap) = spec.and_then(|s| s.capacity.as_ref()).and_then(|c| c.get("storage")) {
        badges.push(cap.0.clone());
    }
    if let Some(policy) = spec.and_then(|s| s.persistent_volume_reclaim_policy.clone()) {
        badges.push(policy);
    }
    (Status::Ok, badges)
}

fn hpa(h: &HorizontalPodAutoscaler) -> (Status, Badges) {
    let spec = h.spec.as_ref();
    let min = spec.and_then(|s| s.min_replicas).unwrap_or(1);
    let max = spec.map(|s| s.max_replicas).unwrap_or(0);
    let st = h.status.as_ref();
    let current = st.and_then(|s| s.current_replicas).unwrap_or(0);
    let limited = st
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| condition_is(cs.iter().map(|c| (c.type_.as_str(), c.status.as_str())), "ScalingLimited", "True"))
        .unwrap_or(false);
    (if limited { Status::Warn } else { Status::Ok }, vec![format!("{min}–{max}"), current.to_string()])
}

fn labels_string(labels: Option<&BTreeMap<String, String>>) -> String {
    labels
        .map(|l| l.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", "))
        .unwrap_or_default()
}

/// Key/value rows for the Overview tab.
pub fn summary(obj: &Object) -> SummaryRows {
    let mut rows: SummaryRows = vec![
        ("Name".into(), obj.name().into()),
        ("Namespace".into(), obj.namespace().unwrap_or("—").into()),
        ("Kind".into(), obj.kind().as_str().into()),
    ];
    if let Some(ts) = &obj.meta().creation_timestamp {
        rows.push(("Created".into(), ts.0.to_rfc3339()));
    }
    let labels = labels_string(obj.meta().labels.as_ref());
    if !labels.is_empty() {
        rows.push(("Labels".into(), labels));
    }
    match obj {
        Object::Pod(p) => {
            let st = p.status.as_ref();
            rows.push(("Phase".into(), st.and_then(|s| s.phase.clone()).unwrap_or_default()));
            rows.push(("Node".into(), p.spec.as_ref().and_then(|s| s.node_name.clone()).unwrap_or_default()));
            rows.push(("Pod IP".into(), st.and_then(|s| s.pod_ip.clone()).unwrap_or_default()));
            let statuses = st.and_then(|s| s.container_statuses.as_ref()).cloned().unwrap_or_default();
            rows.push(("Restarts".into(), statuses.iter().map(|c| c.restart_count).sum::<i32>().to_string()));
            for c in p.spec.as_ref().map(|s| s.containers.as_slice()).unwrap_or_default() {
                rows.push((format!("Container {}", c.name), c.image.clone().unwrap_or_default()));
            }
        }
        Object::Service(s) => {
            let spec = s.spec.as_ref();
            rows.push(("Type".into(), spec.and_then(|s| s.type_.clone()).unwrap_or_default()));
            rows.push(("Cluster IP".into(), spec.and_then(|s| s.cluster_ip.clone()).unwrap_or_default()));
            rows.push(("Selector".into(), labels_string(spec.and_then(|s| s.selector.as_ref()))));
            let ports = spec
                .and_then(|s| s.ports.as_ref())
                .map(|ps| ps.iter().map(|p| format!("{}/{}", p.port, p.protocol.clone().unwrap_or_else(|| "TCP".into()))).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            rows.push(("Ports".into(), ports));
        }
        Object::Deployment(d) => {
            let st = d.status.as_ref();
            rows.push(("Replicas".into(), format!("{} desired / {} ready / {} available",
                d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1),
                st.and_then(|s| s.ready_replicas).unwrap_or(0),
                st.and_then(|s| s.available_replicas).unwrap_or(0))));
            rows.push(("Strategy".into(), d.spec.as_ref().and_then(|s| s.strategy.as_ref()).and_then(|s| s.type_.clone()).unwrap_or_default()));
            if let Some(cs) = st.and_then(|s| s.conditions.as_ref()) {
                rows.extend(cs.iter().map(|c| (format!("Condition {}", c.type_), format!("{} {}", c.status, c.reason.clone().unwrap_or_default()))));
            }
        }
        Object::Ingress(i) => {
            rows.push(("Class".into(), i.spec.as_ref().and_then(|s| s.ingress_class_name.clone()).unwrap_or_default()));
            for r in i.spec.as_ref().and_then(|s| s.rules.as_ref()).map(|r| r.as_slice()).unwrap_or_default() {
                let backends = r
                    .http
                    .as_ref()
                    .map(|h| h.paths.iter().map(|p| format!("{} → {}", p.path.clone().unwrap_or_else(|| "/".into()), p.backend.service.as_ref().map(|s| s.name.clone()).unwrap_or_default())).collect::<Vec<_>>().join("; "))
                    .unwrap_or_default();
                rows.push((format!("Host {}", r.host.clone().unwrap_or_else(|| "*".into())), backends));
            }
        }
        Object::PersistentVolumeClaim(p) => {
            rows.push(("Phase".into(), p.status.as_ref().and_then(|s| s.phase.clone()).unwrap_or_default()));
            rows.push(("Volume".into(), p.spec.as_ref().and_then(|s| s.volume_name.clone()).unwrap_or_default()));
        }
        Object::HorizontalPodAutoscaler(h) => {
            if let Some(cs) = h.status.as_ref().and_then(|s| s.conditions.as_ref()) {
                rows.extend(cs.iter().map(|c| (format!("Condition {}", c.type_), format!("{} {}", c.status, c.reason.clone().unwrap_or_default()))));
            }
        }
        Object::Job(j) => {
            if let Some(cs) = j.status.as_ref().and_then(|s| s.conditions.as_ref()) {
                rows.extend(cs.iter().map(|c| (format!("Condition {}", c.type_), format!("{} {}", c.status, c.reason.clone().unwrap_or_default()))));
            }
        }
        _ => {}
    }
    rows
}
```

Add `pub mod status;` to `src-tauri/src/graph/mod.rs`.

Note: the k8s-openapi field names above (`ready_replicas`, `desired_number_scheduled`, `type_`, `container_statuses`, `restart_count`, `persistent_volume_reclaim_policy`, `Quantity(.0)`) follow the crate's snake_case convention; if a compile error names a field, look it up in `~/.cargo/registry/src/*/k8s-openapi-0.28.0/src/v1_36/api/...` and fix the name — do not change the test expectations.

- [ ] **Step 5: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph::status 2>&1 | tail -8`
Expected: `test result: ok. 5 passed`.

- [ ] **Step 6: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Add per-kind status, badges and summary rows"
```

---

### Task 6: Relationship edges

**Files:**
- Create: `src-tauri/src/graph/relations.rs`
- Create: `src-tauri/tests/fixtures/relations.yaml`
- Modify: `src-tauri/src/graph/mod.rs` (add `pub mod relations;`)

- [ ] **Step 1: Write the fixture** `src-tauri/tests/fixtures/relations.yaml`

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: web-ing, namespace: r }
spec:
  defaultBackend: { service: { name: fallback, port: { number: 80 } } }
  rules:
    - host: web.example.com
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: web-svc, port: { number: 80 } } } }
          - { path: /missing, pathType: Prefix, backend: { service: { name: does-not-exist, port: { number: 80 } } } }
---
apiVersion: v1
kind: Service
metadata: { name: web-svc, namespace: r }
spec: { selector: { app: web }, ports: [ { port: 80, targetPort: 8080 } ] }
---
apiVersion: v1
kind: Service
metadata: { name: fallback, namespace: r }
spec: { selector: { app: fallback }, ports: [ { port: 80 } ] }
---
apiVersion: v1
kind: Service
metadata: { name: headless, namespace: r }
spec: { clusterIP: None, ports: [ { port: 80 } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: r, uid: dep-web }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [ { name: c, image: nginx } ] }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-1
  namespace: r
  uid: rs-web-1
  ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: web, uid: dep-web, controller: true } ]
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec: { containers: [ { name: c, image: nginx } ] }
---
apiVersion: v1
kind: Pod
metadata:
  name: web-1-a
  namespace: r
  labels: { app: web, tier: front }
  ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: web-1, uid: rs-web-1, controller: true } ]
spec:
  serviceAccountName: web-sa
  containers:
    - name: c
      image: nginx
      envFrom:
        - configMapRef: { name: env-cm }
        - secretRef: { name: env-secret }
      env:
        - name: DB_PASS
          valueFrom: { secretKeyRef: { name: db-secret, key: password } }
        - name: FLAG
          valueFrom: { configMapKeyRef: { name: flags-cm, key: flag } }
  volumes:
    - name: cfg
      configMap: { name: mounted-cm }
    - name: tls
      secret: { secretName: mounted-secret }
    - name: data
      persistentVolumeClaim: { claimName: data-pvc }
    - name: proj
      projected:
        sources:
          - configMap: { name: proj-cm }
          - secret: { name: proj-secret }
    - name: ghost
      configMap: { name: missing-cm }
---
apiVersion: v1
kind: Pod
metadata: { name: default-sa-pod, namespace: r, labels: { app: other } }
spec: { containers: [ { name: c, image: nginx } ] }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: web-sa, namespace: r }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: default, namespace: r }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: env-cm, namespace: r }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: flags-cm, namespace: r }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: mounted-cm, namespace: r }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: proj-cm, namespace: r }
---
apiVersion: v1
kind: Secret
metadata: { name: env-secret, namespace: r }
---
apiVersion: v1
kind: Secret
metadata: { name: db-secret, namespace: r }
---
apiVersion: v1
kind: Secret
metadata: { name: mounted-secret, namespace: r }
---
apiVersion: v1
kind: Secret
metadata: { name: proj-secret, namespace: r }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data-pvc, namespace: r }
spec: { accessModes: [ ReadWriteOnce ], volumeName: pv-data, resources: { requests: { storage: 1Gi } } }
status: { phase: Bound }
---
apiVersion: v1
kind: PersistentVolume
metadata: { name: pv-data }
spec: { capacity: { storage: 1Gi }, accessModes: [ ReadWriteOnce ], persistentVolumeReclaimPolicy: Delete }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: web-hpa, namespace: r }
spec: { minReplicas: 1, maxReplicas: 3, scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: web } }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: nightly, namespace: r, uid: cj-nightly }
spec: { schedule: "0 2 * * *", jobTemplate: { spec: { template: { spec: { containers: [ { name: c, image: busybox } ], restartPolicy: Never } } } } }
---
apiVersion: batch/v1
kind: Job
metadata:
  name: nightly-1
  namespace: r
  uid: job-nightly-1
  ownerReferences: [ { apiVersion: batch/v1, kind: CronJob, name: nightly, uid: cj-nightly, controller: true } ]
spec: { template: { spec: { containers: [ { name: c, image: busybox } ], restartPolicy: Never } } }
---
apiVersion: v1
kind: Pod
metadata:
  name: nightly-1-x
  namespace: r
  ownerReferences: [ { apiVersion: batch/v1, kind: Job, name: nightly-1, uid: job-nightly-1, controller: true } ]
spec: { containers: [ { name: c, image: busybox } ], restartPolicy: Never }
```

- [ ] **Step 2: Write the failing tests** (bottom of `src-tauri/src/graph/relations.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::Relation;
    use crate::store::Store;

    fn ids(edges: &[Edge]) -> Vec<String> {
        let mut v: Vec<String> = edges.iter().map(|e| e.id.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn owner_chain_edges() {
        let s = Store::from_fixture("relations").unwrap();
        assert_eq!(
            ids(&owner_edges(&s)),
            vec![
                "CronJob/r/nightly->Job/r/nightly-1:owns",
                "Deployment/r/web->ReplicaSet/r/web-1:owns",
                "Job/r/nightly-1->Pod/r/nightly-1-x:owns",
                "ReplicaSet/r/web-1->Pod/r/web-1-a:owns",
            ]
        );
    }

    #[test]
    fn service_selector_edges_skip_headless_and_unmatched() {
        let s = Store::from_fixture("relations").unwrap();
        assert_eq!(ids(&service_edges(&s)), vec!["Service/r/web-svc->Pod/r/web-1-a:selects"]);
    }

    #[test]
    fn ingress_edges_include_default_backend_and_skip_missing_services() {
        let s = Store::from_fixture("relations").unwrap();
        assert_eq!(
            ids(&ingress_edges(&s)),
            vec!["Ingress/r/web-ing->Service/r/fallback:routes", "Ingress/r/web-ing->Service/r/web-svc:routes"]
        );
    }

    #[test]
    fn pod_input_edges_cover_volumes_env_pvc_and_sa() {
        let s = Store::from_fixture("relations").unwrap();
        let edges = pod_input_edges(&s);
        assert_eq!(
            ids(&edges),
            vec![
                "ConfigMap/r/env-cm->Pod/r/web-1-a:envFrom",
                "ConfigMap/r/flags-cm->Pod/r/web-1-a:envFrom",
                "ConfigMap/r/mounted-cm->Pod/r/web-1-a:mounts",
                "ConfigMap/r/proj-cm->Pod/r/web-1-a:mounts",
                "PersistentVolumeClaim/r/data-pvc->Pod/r/web-1-a:claims",
                "Secret/r/db-secret->Pod/r/web-1-a:envFrom",
                "Secret/r/env-secret->Pod/r/web-1-a:envFrom",
                "Secret/r/mounted-secret->Pod/r/web-1-a:mounts",
                "Secret/r/proj-secret->Pod/r/web-1-a:mounts",
                "ServiceAccount/r/default->Pod/r/default-sa-pod:usesSA",
                "ServiceAccount/r/default->Pod/r/nightly-1-x:usesSA",
                "ServiceAccount/r/web-sa->Pod/r/web-1-a:usesSA",
            ]
        );
        assert!(edges.iter().all(|e| e.relation != Relation::Owns));
    }

    #[test]
    fn pv_and_hpa_edges() {
        let s = Store::from_fixture("relations").unwrap();
        assert_eq!(ids(&pv_edges(&s)), vec!["PersistentVolume//pv-data->PersistentVolumeClaim/r/data-pvc:binds"]);
        assert_eq!(ids(&hpa_edges(&s)), vec!["HorizontalPodAutoscaler/r/web-hpa->Deployment/r/web:scales"]);
    }

    #[test]
    fn all_edges_is_the_union() {
        let s = Store::from_fixture("relations").unwrap();
        let all = all_edges(&s);
        let expected = owner_edges(&s).len() + service_edges(&s).len() + ingress_edges(&s).len()
            + pod_input_edges(&s).len() + pv_edges(&s).len() + hpa_edges(&s).len();
        assert_eq!(all.len(), expected);
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph::relations 2>&1 | tail -5`
Expected: compile error — module `relations` not found.

- [ ] **Step 4: Implement** `src-tauri/src/graph/relations.rs`

```rust
//! Derive edges between objects in a Store. Every function only emits an edge
//! when both endpoints exist in the store.

use k8s_openapi::api::core::v1::PodSpec;

use super::model::{node_id, Edge, Relation};
use super::status::selector_matches;
use crate::store::{Kind, Object, Store};

fn id_of(obj: &Object) -> String {
    node_id(obj.kind(), obj.namespace(), obj.name())
}

/// Edge from `kind/name` in the same namespace as `to`, if that object exists.
fn edge_from_named(store: &Store, kind: Kind, ns: Option<&str>, name: &str, to: &Object, relation: Relation) -> Option<Edge> {
    let src = store.find(kind, ns, name)?;
    Some(Edge::new(id_of(src), id_of(to), relation))
}

/// owner -> child via metadata.ownerReferences (only watched owner kinds).
pub fn owner_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for child in store.iter() {
        let Some(refs) = child.meta().owner_references.as_ref() else { continue };
        for r in refs {
            let Some(kind) = Kind::parse(&r.kind) else { continue };
            if let Some(e) = edge_from_named(store, kind, child.namespace(), &r.name, child, Relation::Owns) {
                edges.push(e);
            }
        }
    }
    edges
}

/// Service -> Pod when spec.selector matches pod labels.
pub fn service_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for svc in store.iter_kind(Kind::Service) {
        let Object::Service(s) = svc else { continue };
        let Some(selector) = s.spec.as_ref().and_then(|s| s.selector.as_ref()) else { continue };
        for pod in store.iter_kind(Kind::Pod).filter(|p| p.namespace() == svc.namespace()) {
            if selector_matches(selector, pod.meta().labels.as_ref()) {
                edges.push(Edge::new(id_of(svc), id_of(pod), Relation::Selects));
            }
        }
    }
    edges
}

/// Ingress -> Service via rules[].http.paths[].backend.service and defaultBackend.
pub fn ingress_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for ing in store.iter_kind(Kind::Ingress) {
        let Object::Ingress(i) = ing else { continue };
        let Some(spec) = i.spec.as_ref() else { continue };
        let mut names: Vec<String> = vec![];
        if let Some(name) = spec.default_backend.as_ref().and_then(|b| b.service.as_ref()).map(|s| s.name.clone()) {
            names.push(name);
        }
        for rule in spec.rules.as_deref().unwrap_or_default() {
            for path in rule.http.as_ref().map(|h| h.paths.as_slice()).unwrap_or_default() {
                if let Some(svc) = path.backend.service.as_ref() {
                    names.push(svc.name.clone());
                }
            }
        }
        names.sort();
        names.dedup();
        for name in names {
            if let Some(svc) = store.find(Kind::Service, ing.namespace(), &name) {
                edges.push(Edge::new(id_of(ing), id_of(svc), Relation::Routes));
            }
        }
    }
    edges
}

/// Everything a pod consumes: ConfigMap/Secret (mounts, envFrom), PVC (claims), ServiceAccount (usesSA).
pub fn pod_input_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for pod in store.iter_kind(Kind::Pod) {
        let Object::Pod(p) = pod else { continue };
        let Some(spec) = p.spec.as_ref() else { continue };
        let ns = pod.namespace();
        let mut push = |kind: Kind, name: &str, relation: Relation| {
            if let Some(e) = edge_from_named(store, kind, ns, name, pod, relation) {
                edges.push(e);
            }
        };
        collect_pod_inputs(spec, &mut push);
    }
    edges.sort_by(|a, b| a.id.cmp(&b.id));
    edges.dedup_by(|a, b| a.id == b.id);
    edges
}

fn collect_pod_inputs(spec: &PodSpec, push: &mut impl FnMut(Kind, &str, Relation)) {
    for v in spec.volumes.as_deref().unwrap_or_default() {
        if let Some(cm) = v.config_map.as_ref().and_then(|c| c.name.as_deref()) {
            push(Kind::ConfigMap, cm, Relation::Mounts);
        }
        if let Some(sec) = v.secret.as_ref().and_then(|s| s.secret_name.as_deref()) {
            push(Kind::Secret, sec, Relation::Mounts);
        }
        if let Some(pvc) = v.persistent_volume_claim.as_ref() {
            push(Kind::PersistentVolumeClaim, &pvc.claim_name, Relation::Claims);
        }
        for src in v.projected.as_ref().and_then(|p| p.sources.as_deref()).unwrap_or_default() {
            if let Some(cm) = src.config_map.as_ref().and_then(|c| c.name.as_deref()) {
                push(Kind::ConfigMap, cm, Relation::Mounts);
            }
            if let Some(sec) = src.secret.as_ref().and_then(|s| s.name.as_deref()) {
                push(Kind::Secret, sec, Relation::Mounts);
            }
        }
    }
    let containers = spec.containers.iter().chain(spec.init_containers.as_deref().unwrap_or_default());
    for c in containers {
        for ef in c.env_from.as_deref().unwrap_or_default() {
            if let Some(cm) = ef.config_map_ref.as_ref().map(|r| r.name.as_str()) {
                push(Kind::ConfigMap, cm, Relation::EnvFrom);
            }
            if let Some(sec) = ef.secret_ref.as_ref().map(|r| r.name.as_str()) {
                push(Kind::Secret, sec, Relation::EnvFrom);
            }
        }
        for env in c.env.as_deref().unwrap_or_default() {
            let Some(from) = env.value_from.as_ref() else { continue };
            if let Some(r) = from.config_map_key_ref.as_ref() {
                push(Kind::ConfigMap, &r.name, Relation::EnvFrom);
            }
            if let Some(r) = from.secret_key_ref.as_ref() {
                push(Kind::Secret, &r.name, Relation::EnvFrom);
            }
        }
    }
    let sa = spec.service_account_name.as_deref().unwrap_or("default");
    push(Kind::ServiceAccount, sa, Relation::UsesSa);
}

/// PersistentVolume -> PersistentVolumeClaim via pvc.spec.volumeName.
pub fn pv_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for pvc in store.iter_kind(Kind::PersistentVolumeClaim) {
        let Object::PersistentVolumeClaim(p) = pvc else { continue };
        let Some(vol) = p.spec.as_ref().and_then(|s| s.volume_name.as_deref()) else { continue };
        if let Some(e) = edge_from_named(store, Kind::PersistentVolume, None, vol, pvc, Relation::Binds) {
            edges.push(e);
        }
    }
    edges
}

/// HorizontalPodAutoscaler -> scaleTargetRef (Deployment / StatefulSet / ReplicaSet).
pub fn hpa_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for hpa in store.iter_kind(Kind::HorizontalPodAutoscaler) {
        let Object::HorizontalPodAutoscaler(h) = hpa else { continue };
        let Some(spec) = h.spec.as_ref() else { continue };
        let Some(kind) = Kind::parse(&spec.scale_target_ref.kind) else { continue };
        if let Some(target) = store.find(kind, hpa.namespace(), &spec.scale_target_ref.name) {
            edges.push(Edge::new(id_of(hpa), id_of(target), Relation::Scales));
        }
    }
    edges
}

pub fn all_edges(store: &Store) -> Vec<Edge> {
    let mut edges = owner_edges(store);
    edges.extend(service_edges(store));
    edges.extend(ingress_edges(store));
    edges.extend(pod_input_edges(store));
    edges.extend(pv_edges(store));
    edges.extend(hpa_edges(store));
    edges
}
```

Add `pub mod relations;` to `src-tauri/src/graph/mod.rs`.

- [ ] **Step 5: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph::relations 2>&1 | tail -8`
Expected: `test result: ok. 6 passed`.

- [ ] **Step 6: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Derive relationship edges from owners, selectors, ingress, volumes, PV, HPA"
```

---

### Task 7: `build()` — nodes, ReplicaSet hiding, PodGroup collapse

**Files:**
- Create: `src-tauri/src/graph/build.rs`
- Create: `src-tauri/tests/fixtures/podgroup.yaml`
- Modify: `src-tauri/src/graph/mod.rs` (add `pub mod build;` and `pub use build::{build, BuildOptions};`)

Rules implemented here (from spec §5.1, §5.3):
1. Every stored object becomes a node with `describe()` status/badges.
2. ReplicaSets with zero desired **and** zero current replicas are omitted entirely (old revisions).
3. If a Deployment then has exactly one remaining ReplicaSet, that ReplicaSet is hidden and its `owns` edges are re-pointed to the Deployment.
4. Pods sharing an immediate owner (after rule 3) are collapsed into a `PodGroup` when there are more than `group_threshold` (5) of them and the group is not in `expanded_groups`. Group id: `PodGroup/<ns>/<OwnerKind>/<ownerName>`. All edges touching member pods are re-pointed to the group and de-duplicated.

- [ ] **Step 1: Write the fixture** `src-tauri/tests/fixtures/podgroup.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: g, uid: dep-api }
spec:
  replicas: 7
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec: { containers: [ { name: c, image: api:2 } ] }
status: { replicas: 7, readyReplicas: 6 }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: api-new
  namespace: g
  uid: rs-api-new
  ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: api, uid: dep-api, controller: true } ]
spec:
  replicas: 7
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec: { containers: [ { name: c, image: api:2 } ] }
status: { replicas: 7, readyReplicas: 6 }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: api-old
  namespace: g
  uid: rs-api-old
  ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: api, uid: dep-api, controller: true } ]
spec:
  replicas: 0
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec: { containers: [ { name: c, image: api:1 } ] }
status: { replicas: 0 }
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: g }
spec: { selector: { app: api }, ports: [ { port: 80 } ] }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: api-cfg, namespace: g }
---
apiVersion: v1
kind: Pod
metadata: { name: api-new-1, namespace: g, labels: { app: api }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: api-new, uid: rs-api-new, controller: true } ] }
spec: { containers: [ { name: c, image: api:2, envFrom: [ { configMapRef: { name: api-cfg } } ] } ] }
status: { phase: Running, containerStatuses: [ { name: c, ready: true, restartCount: 0, image: api:2, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: api-new-2, namespace: g, labels: { app: api }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: api-new, uid: rs-api-new, controller: true } ] }
spec: { containers: [ { name: c, image: api:2, envFrom: [ { configMapRef: { name: api-cfg } } ] } ] }
status: { phase: Running, containerStatuses: [ { name: c, ready: true, restartCount: 0, image: api:2, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: api-new-3, namespace: g, labels: { app: api }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: api-new, uid: rs-api-new, controller: true } ] }
spec: { containers: [ { name: c, image: api:2, envFrom: [ { configMapRef: { name: api-cfg } } ] } ] }
status: { phase: Running, containerStatuses: [ { name: c, ready: true, restartCount: 0, image: api:2, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: api-new-4, namespace: g, labels: { app: api }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: api-new, uid: rs-api-new, controller: true } ] }
spec: { containers: [ { name: c, image: api:2, envFrom: [ { configMapRef: { name: api-cfg } } ] } ] }
status: { phase: Running, containerStatuses: [ { name: c, ready: true, restartCount: 0, image: api:2, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: api-new-5, namespace: g, labels: { app: api }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: api-new, uid: rs-api-new, controller: true } ] }
spec: { containers: [ { name: c, image: api:2, envFrom: [ { configMapRef: { name: api-cfg } } ] } ] }
status: { phase: Running, containerStatuses: [ { name: c, ready: true, restartCount: 0, image: api:2, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: api-new-6, namespace: g, labels: { app: api }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: api-new, uid: rs-api-new, controller: true } ] }
spec: { containers: [ { name: c, image: api:2, envFrom: [ { configMapRef: { name: api-cfg } } ] } ] }
status: { phase: Running, containerStatuses: [ { name: c, ready: true, restartCount: 0, image: api:2, imageID: "", state: { running: { startedAt: "2026-09-17T10:00:00Z" } } } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: api-new-7, namespace: g, labels: { app: api }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: api-new, uid: rs-api-new, controller: true } ] }
spec: { containers: [ { name: c, image: api:2, envFrom: [ { configMapRef: { name: api-cfg } } ] } ] }
status: { phase: Running, containerStatuses: [ { name: c, ready: false, restartCount: 9, image: api:2, imageID: "", state: { waiting: { reason: CrashLoopBackOff } } } ] }
```

- [ ] **Step 2: Write the failing tests** (bottom of `src-tauri/src/graph/build.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::Status;
    use crate::store::{Kind, Store};

    fn edge_ids(g: &Graph) -> Vec<&str> {
        g.edges.iter().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn basic_deployment_hides_single_active_replicaset() {
        let s = Store::from_fixture("deployment-basic").unwrap();
        let g = build(&s, &BuildOptions::default());
        let kinds: Vec<Kind> = g.nodes.iter().map(|n| n.kind).collect();
        assert!(!kinds.contains(&Kind::ReplicaSet), "single active RS must be hidden");
        assert_eq!(g.nodes.len(), 3);
        assert_eq!(
            edge_ids(&g),
            vec![
                "Deployment/payments/web->Pod/payments/web-7f9c-aaaaa:owns",
                "Deployment/payments/web->Pod/payments/web-7f9c-bbbbb:owns",
            ]
        );
    }

    #[test]
    fn old_replicasets_are_dropped_and_pods_collapse_into_group() {
        let s = Store::from_fixture("podgroup").unwrap();
        let g = build(&s, &BuildOptions::default());
        assert!(g.node("ReplicaSet/g/api-old").is_none(), "scaled-to-zero RS omitted");
        assert!(g.node("ReplicaSet/g/api-new").is_none(), "single remaining RS hidden");
        assert!(g.nodes.iter().all(|n| n.kind != Kind::Pod), "pods collapsed");
        let group = g.node("PodGroup/g/Deployment/api").expect("group node");
        assert_eq!(group.status, Status::Err);
        assert_eq!(group.group, Some(GroupInfo { count: 7, ok: 6, warn: 0, err: 1 }));
        assert_eq!(group.badges, vec!["×7", "6 ok · 1 err"]);
        assert_eq!(
            edge_ids(&g),
            vec![
                "ConfigMap/g/api-cfg->PodGroup/g/Deployment/api:envFrom",
                "Deployment/g/api->PodGroup/g/Deployment/api:owns",
                "Service/g/api->PodGroup/g/Deployment/api:selects",
            ]
        );
    }

    #[test]
    fn expanded_group_shows_individual_pods() {
        let s = Store::from_fixture("podgroup").unwrap();
        let opts = BuildOptions { expanded_groups: ["PodGroup/g/Deployment/api".to_string()].into_iter().collect(), ..Default::default() };
        let g = build(&s, &opts);
        assert!(g.node("PodGroup/g/Deployment/api").is_none());
        assert_eq!(g.nodes.iter().filter(|n| n.kind == Kind::Pod).count(), 7);
        assert!(g.edges.iter().any(|e| e.id == "Deployment/g/api->Pod/g/api-new-7:owns"));
    }

    #[test]
    fn threshold_is_strictly_greater_than() {
        let s = Store::from_fixture("podgroup").unwrap();
        let opts = BuildOptions { group_threshold: 7, ..Default::default() };
        let g = build(&s, &opts);
        assert!(g.node("PodGroup/g/Deployment/api").is_none(), "7 pods with threshold 7 stay expanded");
    }

    #[test]
    fn output_is_normalized_and_deterministic() {
        let s = Store::from_fixture("relations").unwrap();
        let a = build(&s, &BuildOptions::default());
        let b = build(&s, &BuildOptions::default());
        assert_eq!(a, b);
        let ids: Vec<&str> = a.nodes.iter().map(|n| n.id.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph::build 2>&1 | tail -5`
Expected: compile error — module `build` not found.

- [ ] **Step 4: Implement** `src-tauri/src/graph/build.rs`

```rust
//! Store -> Graph. Pure and deterministic.

use std::collections::{BTreeMap, HashMap, HashSet};

use super::model::{node_id, Edge, Graph, GroupInfo, Node, NodeId, Relation, Status};
use super::relations::all_edges;
use super::status::describe;
use crate::store::{Kind, Object, Store};

#[derive(Debug, Clone)]
pub struct BuildOptions {
    pub expanded_groups: HashSet<NodeId>,
    /// Collapse pods of one owner when there are more than this many.
    pub group_threshold: usize,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self { expanded_groups: HashSet::new(), group_threshold: 5 }
    }
}

pub fn build(store: &Store, opts: &BuildOptions) -> Graph {
    let mut nodes: HashMap<NodeId, Node> = HashMap::new();
    for obj in store.iter() {
        if is_stale_replicaset(obj) {
            continue;
        }
        let (status, badges) = describe(obj, store);
        let id = node_id(obj.kind(), obj.namespace(), obj.name());
        nodes.insert(
            id.clone(),
            Node { id, kind: obj.kind(), namespace: obj.namespace().map(str::to_owned), name: obj.name().to_owned(), status, badges, group: None },
        );
    }

    let mut edges: Vec<Edge> = all_edges(store)
        .into_iter()
        .filter(|e| nodes.contains_key(&e.source) && nodes.contains_key(&e.target))
        .collect();

    hide_single_replicasets(&mut nodes, &mut edges);
    collapse_pod_groups(&mut nodes, &mut edges, opts);

    let mut graph = Graph { nodes: nodes.into_values().collect(), edges };
    graph.normalize();
    graph
}

/// Old revisions: desired 0 and current 0.
fn is_stale_replicaset(obj: &Object) -> bool {
    let Object::ReplicaSet(rs) = obj else { return false };
    let desired = rs.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let current = rs.status.as_ref().map(|s| s.replicas).unwrap_or(0);
    desired == 0 && current == 0
}

/// A Deployment with exactly one ReplicaSet child: drop the RS node, re-point RS->X edges to the Deployment.
fn hide_single_replicasets(nodes: &mut HashMap<NodeId, Node>, edges: &mut Vec<Edge>) {
    let mut children: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
    for e in edges.iter() {
        if e.relation == Relation::Owns
            && nodes.get(&e.source).map(|n| n.kind) == Some(Kind::Deployment)
            && nodes.get(&e.target).map(|n| n.kind) == Some(Kind::ReplicaSet)
        {
            children.entry(e.source.clone()).or_default().push(e.target.clone());
        }
    }
    for (dep, rss) in children {
        if rss.len() != 1 {
            continue;
        }
        let rs = &rss[0];
        nodes.remove(rs);
        *edges = edges
            .drain(..)
            .filter(|e| !(e.source == dep && e.target == *rs))
            .map(|e| if e.source == *rs { Edge::new(dep.clone(), e.target, e.relation) } else { e })
            .collect();
    }
}

/// Collapse pods with the same immediate owner into a PodGroup node.
fn collapse_pod_groups(nodes: &mut HashMap<NodeId, Node>, edges: &mut Vec<Edge>, opts: &BuildOptions) {
    // owner id -> member pod ids
    let mut members: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
    for e in edges.iter() {
        if e.relation == Relation::Owns && nodes.get(&e.target).map(|n| n.kind) == Some(Kind::Pod) {
            members.entry(e.source.clone()).or_default().push(e.target.clone());
        }
    }

    let mut remap: HashMap<NodeId, NodeId> = HashMap::new();
    for (owner_id, pods) in members {
        if pods.len() <= opts.group_threshold {
            continue;
        }
        let (owner_ns, owner_kind, owner_name) = {
            let o = &nodes[&owner_id];
            (o.namespace.clone(), o.kind, o.name.clone())
        };
        let group_id = format!("PodGroup/{}/{}/{}", owner_ns.as_deref().unwrap_or(""), owner_kind.as_str(), owner_name);
        if opts.expanded_groups.contains(&group_id) {
            continue;
        }
        let mut info = GroupInfo { count: pods.len(), ok: 0, warn: 0, err: 0 };
        let mut worst = Status::Unknown;
        for pod_id in &pods {
            let pod = nodes.remove(pod_id).expect("member pod exists");
            match pod.status {
                Status::Ok => info.ok += 1,
                Status::Warn => info.warn += 1,
                Status::Err => info.err += 1,
                Status::Unknown => {}
            }
            worst = worst.max(pod.status);
            remap.insert(pod_id.clone(), group_id.clone());
        }
        let mut counts = vec![];
        if info.ok > 0 { counts.push(format!("{} ok", info.ok)); }
        if info.warn > 0 { counts.push(format!("{} warn", info.warn)); }
        if info.err > 0 { counts.push(format!("{} err", info.err)); }
        nodes.insert(
            group_id.clone(),
            Node {
                id: group_id.clone(),
                kind: Kind::PodGroup,
                namespace: owner_ns,
                name: owner_name,
                status: worst,
                badges: vec![format!("×{}", info.count), counts.join(" · ")],
                group: Some(info),
            },
        );
    }

    if remap.is_empty() {
        return;
    }
    *edges = edges
        .drain(..)
        .map(|e| {
            let source = remap.get(&e.source).cloned().unwrap_or(e.source);
            let target = remap.get(&e.target).cloned().unwrap_or(e.target);
            Edge::new(source, target, e.relation)
        })
        .collect();
}
```

Update `src-tauri/src/graph/mod.rs` to:
```rust
//! Pure graph construction: Store -> Graph, Graph x Graph -> GraphDelta.

pub mod build;
pub mod model;
pub mod relations;
pub mod status;

pub use build::{build, BuildOptions};
pub use model::*;
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph:: 2>&1 | tail -8`
Expected: all graph tests pass (`5 passed` for build plus earlier ones).

- [ ] **Step 6: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Build graph with ReplicaSet hiding and PodGroup collapsing"
```

---

### Task 8: `diff()` — minimal deltas

**Files:**
- Create: `src-tauri/src/graph/diff.rs`
- Modify: `src-tauri/src/graph/mod.rs` (add `pub mod diff;` and `pub use diff::diff;`)

- [ ] **Step 1: Write the failing tests** (bottom of `src-tauri/src/graph/diff.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::{Edge, Node, Relation, Status};
    use crate::store::Kind;

    fn node(id: &str, status: Status) -> Node {
        Node { id: id.into(), kind: Kind::Pod, namespace: Some("n".into()), name: id.into(), status, badges: vec![], group: None }
    }

    fn graph(nodes: Vec<Node>, edges: Vec<Edge>) -> Graph {
        let mut g = Graph { nodes, edges };
        g.normalize();
        g
    }

    #[test]
    fn identical_graphs_give_empty_delta() {
        let g = graph(vec![node("a", Status::Ok)], vec![]);
        assert!(diff(&g, &g).is_empty());
    }

    #[test]
    fn detects_added_updated_removed_nodes_and_edges() {
        let old = graph(
            vec![node("a", Status::Ok), node("b", Status::Ok), node("c", Status::Ok)],
            vec![Edge::new("a", "b", Relation::Owns), Edge::new("a", "c", Relation::Owns)],
        );
        let new = graph(
            vec![node("a", Status::Ok), node("b", Status::Err), node("d", Status::Ok)],
            vec![Edge::new("a", "b", Relation::Owns), Edge::new("a", "d", Relation::Owns)],
        );
        let d = diff(&old, &new);
        assert_eq!(d.added_nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec!["d"]);
        assert_eq!(d.updated_nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(d.removed_nodes, vec!["c"]);
        assert_eq!(d.added_edges.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["a->d:owns"]);
        assert_eq!(d.removed_edges, vec!["a->c:owns"]);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph::diff 2>&1 | tail -5`
Expected: compile error — module `diff` not found.

- [ ] **Step 3: Implement** `src-tauri/src/graph/diff.rs`

```rust
//! Compute the minimal change set between two normalized graphs.

use std::collections::HashMap;

use super::model::{Graph, GraphDelta};

pub fn diff(old: &Graph, new: &Graph) -> GraphDelta {
    let old_nodes: HashMap<&str, _> = old.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let new_nodes: HashMap<&str, _> = new.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let old_edges: HashMap<&str, _> = old.edges.iter().map(|e| (e.id.as_str(), e)).collect();
    let new_edges: HashMap<&str, _> = new.edges.iter().map(|e| (e.id.as_str(), e)).collect();

    let mut delta = GraphDelta::default();
    for n in &new.nodes {
        match old_nodes.get(n.id.as_str()) {
            None => delta.added_nodes.push(n.clone()),
            Some(o) if *o != n => delta.updated_nodes.push(n.clone()),
            Some(_) => {}
        }
    }
    for n in &old.nodes {
        if !new_nodes.contains_key(n.id.as_str()) {
            delta.removed_nodes.push(n.id.clone());
        }
    }
    for e in &new.edges {
        if !old_edges.contains_key(e.id.as_str()) {
            delta.added_edges.push(e.clone());
        }
    }
    for e in &old.edges {
        if !new_edges.contains_key(e.id.as_str()) {
            delta.removed_edges.push(e.id.clone());
        }
    }
    delta
}
```

Add `pub mod diff;` and `pub use diff::diff;` to `src-tauri/src/graph/mod.rs`.

- [ ] **Step 4: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test graph::diff 2>&1 | tail -5`
Expected: `test result: ok. 2 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Add graph diff producing minimal deltas"
```

---

### Task 9: kubeconfig discovery

**Files:**
- Create: `src-tauri/src/kubeconfig.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod kubeconfig;`), `src-tauri/Cargo.toml` (add `tempfile = "3"` under `[dev-dependencies]`)

Semantics follow `kubectl`: files are merged in order and **the first file that defines a context name wins**. (The spec said "later file wins"; kubectl and `kube::config::Kubeconfig::merge` both do first-wins, so we match them — update spec §9 wording when this task lands.)

- [ ] **Step 1: Write the failing tests** (bottom of `src-tauri/src/kubeconfig.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn kubeconfig_file(dir: &std::path::Path, name: &str, contexts: &[(&str, &str, &str)]) -> PathBuf {
        let mut yaml = String::from("apiVersion: v1\nkind: Config\nclusters:\n  - name: c1\n    cluster: { server: https://127.0.0.1:6443 }\nusers:\n  - name: u1\n    user: { token: abc }\ncontexts:\n");
        for (ctx, cluster, user) in contexts {
            yaml.push_str(&format!("  - name: {ctx}\n    context: {{ cluster: {cluster}, user: {user}, namespace: default }}\n"));
        }
        yaml.push_str(&format!("current-context: {}\n", contexts[0].0));
        let path = dir.join(name);
        std::fs::File::create(&path).unwrap().write_all(yaml.as_bytes()).unwrap();
        path
    }

    #[test]
    fn lists_contexts_from_multiple_files_first_wins() {
        let dir = tempfile::tempdir().unwrap();
        let a = kubeconfig_file(dir.path(), "a", &[("prod", "c1", "u1"), ("shared", "c1", "u1")]);
        let b = kubeconfig_file(dir.path(), "b", &[("dev", "c1", "u1"), ("shared", "c1", "u1")]);
        let contexts = list_contexts(&[a.clone(), b.clone()]).unwrap();
        let names: Vec<&str> = contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["dev", "prod", "shared"]);
        let shared = contexts.iter().find(|c| c.name == "shared").unwrap();
        assert_eq!(shared.source_file, a.to_string_lossy());
        assert_eq!(shared.namespace.as_deref(), Some("default"));
        assert_eq!(shared.cluster, "c1");
    }

    #[test]
    fn missing_file_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let a = kubeconfig_file(dir.path(), "a", &[("prod", "c1", "u1")]);
        let contexts = list_contexts(&[dir.path().join("nope"), a]).unwrap();
        assert_eq!(contexts.len(), 1);
    }

    #[test]
    fn splits_kubeconfig_env_on_platform_separator() {
        let sep = if cfg!(windows) { ';' } else { ':' };
        let paths = split_env_paths(&format!("/a/one{sep}/b/two{sep}"));
        assert_eq!(paths, vec![PathBuf::from("/a/one"), PathBuf::from("/b/two")]);
    }

    #[test]
    fn merged_kubeconfig_can_select_a_context() {
        let dir = tempfile::tempdir().unwrap();
        let a = kubeconfig_file(dir.path(), "a", &[("prod", "c1", "u1")]);
        let merged = load_merged(&[a]).unwrap();
        assert!(merged.contexts.iter().any(|c| c.name == "prod"));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test kubeconfig 2>&1 | tail -5`
Expected: compile error — module not found.

- [ ] **Step 3: Implement** `src-tauri/src/kubeconfig.rs`

```rust
//! Discover kubeconfig files and the contexts they define.

use std::path::PathBuf;

use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorKind};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub source_file: String,
}

const ENV_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

pub fn split_env_paths(value: &str) -> Vec<PathBuf> {
    value.split(ENV_SEPARATOR).filter(|s| !s.is_empty()).map(PathBuf::from).collect()
}

/// `$KUBECONFIG` entries if set, otherwise `~/.kube/config`.
pub fn default_paths() -> Vec<PathBuf> {
    if let Ok(env) = std::env::var("KUBECONFIG") {
        let paths = split_env_paths(&env);
        if !paths.is_empty() {
            return paths;
        }
    }
    dirs::home_dir().map(|h| vec![h.join(".kube").join("config")]).unwrap_or_default()
}

fn read_existing(paths: &[PathBuf]) -> AppResult<Vec<(PathBuf, Kubeconfig)>> {
    let mut out = vec![];
    for p in paths {
        if !p.exists() {
            tracing::debug!(path = %p.display(), "kubeconfig not found, skipping");
            continue;
        }
        let cfg = Kubeconfig::read_from(p)
            .map_err(|e| AppError::new(ErrorKind::Internal, format!("{}: {e}", p.display())))?;
        out.push((p.clone(), cfg));
    }
    Ok(out)
}

/// All contexts across files, sorted by name. First file defining a name wins.
pub fn list_contexts(paths: &[PathBuf]) -> AppResult<Vec<ContextInfo>> {
    let mut seen = std::collections::HashSet::new();
    let mut contexts = vec![];
    for (path, cfg) in read_existing(paths)? {
        for named in &cfg.contexts {
            if !seen.insert(named.name.clone()) {
                continue;
            }
            let ctx = named.context.clone().unwrap_or_default();
            contexts.push(ContextInfo {
                name: named.name.clone(),
                cluster: ctx.cluster,
                user: ctx.user.unwrap_or_default(),
                namespace: ctx.namespace,
                source_file: path.to_string_lossy().into_owned(),
            });
        }
    }
    contexts.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(contexts)
}

/// One merged Kubeconfig suitable for `kube::Config::from_custom_kubeconfig`.
pub fn load_merged(paths: &[PathBuf]) -> AppResult<Kubeconfig> {
    let mut merged = Kubeconfig::default();
    for (path, cfg) in read_existing(paths)? {
        merged = merged
            .merge(cfg)
            .map_err(|e| AppError::new(ErrorKind::Internal, format!("merging {}: {e}", path.display())))?;
    }
    if merged.contexts.is_empty() {
        return Err(AppError::new(ErrorKind::NotFound, "no kubeconfig contexts found"));
    }
    Ok(merged)
}

pub fn path_strings(paths: &[PathBuf]) -> Vec<String> {
    paths.iter().map(|p| p.to_string_lossy().into_owned()).collect()
}
```

Add `pub mod kubeconfig;` to `lib.rs` and `tempfile = "3"` to `[dev-dependencies]`.

- [ ] **Step 4: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test kubeconfig 2>&1 | tail -6`
Expected: `test result: ok. 4 passed`. If `Context` fields differ (e.g. `user` is `String` not `Option<String>`), adjust the `.unwrap_or_default()` call — the test expectations stay.

- [ ] **Step 5: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Discover kubeconfig contexts across files"
```

---

### Task 10: Emitter, `OutEvent`, watcher tasks

**Files:**
- Create: `src-tauri/src/session/mod.rs` (module declarations only for now), `src-tauri/src/session/emitter.rs`, `src-tauri/src/session/watch.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod session;`)

- [ ] **Step 1: Write the failing tests** (bottom of `src-tauri/src/session/emitter.rs`)

```rust
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test session::emitter 2>&1 | tail -5`
Expected: compile error — module not found.

- [ ] **Step 3: Implement**

`src-tauri/src/session/mod.rs` (for now):
```rust
//! One live connection to a cluster: watchers, store, graph, events.

pub mod emitter;
pub mod watch;
```

`src-tauri/src/session/emitter.rs`:
```rust
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
```

`src-tauri/src/session/watch.rs`:
```rust
//! One watcher task per kind, feeding `StoreEvent`s into the reducer.

use futures::StreamExt;
use kube::api::Api;
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use kube::{Client, Resource};
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::error::{AppError, ErrorKind};
use crate::store::{Kind, Object, ObjectKey};

#[derive(Debug, Clone)]
pub enum StoreEvent {
    Applied(Object),
    Deleted(ObjectKey),
    /// Initial list for this kind is complete.
    InitDone(Kind),
    /// Watcher hit an error. `fatal` = permission denied, watcher stopped.
    Failed { kind: Kind, error: AppError, fatal: bool },
    /// Watcher produced data again after an error.
    Recovered(Kind),
}

/// Typed k8s-openapi resource -> `Object`.
pub trait IntoObject: Resource<DynamicType = ()> + Clone + DeserializeOwned + std::fmt::Debug + Send + Sync + 'static {
    const KIND: Kind;
    fn into_object(self) -> Object;
}

macro_rules! into_object {
    ($($ty:ty => $variant:ident),* $(,)?) => {
        $(impl IntoObject for $ty {
            const KIND: Kind = Kind::$variant;
            fn into_object(self) -> Object { Object::$variant(self) }
        })*
    };
}

into_object! {
    k8s_openapi::api::apps::v1::Deployment => Deployment,
    k8s_openapi::api::apps::v1::StatefulSet => StatefulSet,
    k8s_openapi::api::apps::v1::DaemonSet => DaemonSet,
    k8s_openapi::api::apps::v1::ReplicaSet => ReplicaSet,
    k8s_openapi::api::batch::v1::Job => Job,
    k8s_openapi::api::batch::v1::CronJob => CronJob,
    k8s_openapi::api::core::v1::Pod => Pod,
    k8s_openapi::api::core::v1::Service => Service,
    k8s_openapi::api::networking::v1::Ingress => Ingress,
    k8s_openapi::api::core::v1::ConfigMap => ConfigMap,
    k8s_openapi::api::core::v1::Secret => Secret,
    k8s_openapi::api::core::v1::PersistentVolumeClaim => PersistentVolumeClaim,
    k8s_openapi::api::core::v1::PersistentVolume => PersistentVolume,
    k8s_openapi::api::core::v1::ServiceAccount => ServiceAccount,
    k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler => HorizontalPodAutoscaler,
}

pub fn app_error_from_kube(e: &kube::Error) -> AppError {
    match e {
        kube::Error::Api(resp) if resp.code == 401 => AppError::new(ErrorKind::Auth, resp.message.clone()),
        kube::Error::Api(resp) if resp.code == 403 => AppError::new(ErrorKind::Forbidden, resp.message.clone()),
        kube::Error::Api(resp) if resp.code == 404 => AppError::new(ErrorKind::NotFound, resp.message.clone()),
        kube::Error::Api(resp) => AppError::new(ErrorKind::Internal, resp.message.clone()),
        kube::Error::Auth(e) => AppError::new(ErrorKind::Auth, e.to_string()),
        kube::Error::HyperError(_) | kube::Error::Service(_) => AppError::new(ErrorKind::Network, e.to_string()),
        other => AppError::new(ErrorKind::Internal, other.to_string()),
    }
}

fn classify(kind: Kind, e: &watcher::Error) -> StoreEvent {
    let (error, fatal) = match e {
        watcher::Error::InitialListFailed(k) | watcher::Error::WatchStartFailed(k) | watcher::Error::WatchFailed(k) => {
            let app = app_error_from_kube(k);
            let fatal = app.kind == ErrorKind::Forbidden;
            (app, fatal)
        }
        watcher::Error::WatchError(resp) if resp.code == 403 => (AppError::new(ErrorKind::Forbidden, resp.message.clone()), true),
        other => (AppError::new(ErrorKind::Network, other.to_string()), false),
    };
    StoreEvent::Failed { kind, error, fatal }
}

/// Spawn a watcher over `api` (namespaced or cluster-wide — the caller decides).
pub fn spawn_watch<K: IntoObject>(api: Api<K>, tx: mpsc::Sender<StoreEvent>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let kind = K::KIND;
        let mut stream = watcher(api, watcher::Config::default()).default_backoff().boxed();
        let mut errored = false;
        while let Some(item) = stream.next().await {
            let ev = match item {
                Ok(Event::Init) => continue,
                Ok(Event::InitApply(obj)) | Ok(Event::Apply(obj)) => StoreEvent::Applied(obj.into_object()),
                Ok(Event::Delete(obj)) => StoreEvent::Deleted(obj.into_object().key()),
                Ok(Event::InitDone) => StoreEvent::InitDone(kind),
                Err(e) => {
                    tracing::warn!(?kind, error = %e, "watcher error");
                    let ev = classify(kind, &e);
                    let fatal = matches!(ev, StoreEvent::Failed { fatal: true, .. });
                    errored = true;
                    let _ = tx.send(ev).await;
                    if fatal {
                        return;
                    }
                    continue;
                }
            };
            if errored {
                errored = false;
                let _ = tx.send(StoreEvent::Recovered(kind)).await;
            }
            if tx.send(ev).await.is_err() {
                return; // reducer gone
            }
        }
    })
}

/// Start all 15 watchers for a namespace.
pub fn spawn_all(client: &Client, namespace: &str, tx: &mpsc::Sender<StoreEvent>) -> Vec<JoinHandle<()>> {
    use k8s_openapi::api::{apps::v1 as apps, autoscaling::v2 as autoscaling, batch::v1 as batch, core::v1 as core, networking::v1 as networking};
    macro_rules! ns {
        ($ty:ty) => { spawn_watch(Api::<$ty>::namespaced(client.clone(), namespace), tx.clone()) };
    }
    vec![
        ns!(apps::Deployment),
        ns!(apps::StatefulSet),
        ns!(apps::DaemonSet),
        ns!(apps::ReplicaSet),
        ns!(batch::Job),
        ns!(batch::CronJob),
        ns!(core::Pod),
        ns!(core::Service),
        ns!(networking::Ingress),
        ns!(core::ConfigMap),
        ns!(core::Secret),
        ns!(core::PersistentVolumeClaim),
        spawn_watch(Api::<core::PersistentVolume>::all(client.clone()), tx.clone()),
        ns!(core::ServiceAccount),
        ns!(autoscaling::HorizontalPodAutoscaler),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forbidden_is_fatal_network_is_not() {
        let resp = kube::core::ErrorResponse { status: "Failure".into(), message: "forbidden".into(), reason: "Forbidden".into(), code: 403 };
        let ev = classify(Kind::Secret, &watcher::Error::WatchError(resp));
        assert!(matches!(ev, StoreEvent::Failed { kind: Kind::Secret, fatal: true, .. }));
        let ev = classify(Kind::Pod, &watcher::Error::NoResourceVersion);
        assert!(matches!(ev, StoreEvent::Failed { fatal: false, .. }));
    }
}
```

Add `pub mod session;` to `lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test session:: 2>&1 | tail -6`
Expected: `test result: ok. 3 passed`. If `watcher::Error` or `kube::Error` variant names differ in kube 4.2, open `~/.cargo/registry/src/*/kube-runtime-4.2.0/src/watcher.rs` / `kube-client-4.2.0/src/error.rs`, adjust `classify` / `app_error_from_kube` to the real variants (keep the mapping: 401 ⇒ Auth, 403 ⇒ fatal Forbidden, 404 ⇒ NotFound, transport ⇒ Network, everything else ⇒ Internal).

- [ ] **Step 5: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Add emitter abstraction and per-kind watcher tasks"
```

---

### Task 11: Reducer — apply, debounce, build, diff, emit, degraded detection

**Files:**
- Create: `src-tauri/src/session/reducer.rs`
- Modify: `src-tauri/src/session/mod.rs` (add `pub mod reducer;`)

Behaviour:
- Applies `StoreEvent`s to the shared `Store`.
- Emits nothing until every non-fatal kind has reported `InitDone` (a fatal `Failed` counts as done for that kind); then emits `graph_snapshot`.
- After that, any change marks the graph dirty; a rebuild happens `debounce` after the **first** dirty event (trailing edge with a fixed deadline, so a flood of events cannot starve it). `graph_delta` is emitted only if the delta is non-empty.
- `ReducerMsg::Rebuild` (from `set_expanded_groups`) forces a rebuild immediately.
- Every `tick`, if any kind has been in error for longer than `degraded_after`, emits `connection_state: degraded` (once). When all kinds have recovered, emits `connected` and a fresh `graph_snapshot`.
- Fatal failures are reported as `connection_error` and the kind is added to `denied_kinds` (shared with `Session` so the frontend can ask).

- [ ] **Step 1: Write the failing tests** (bottom of `src-tauri/src/session/reducer.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::emitter::{ChannelEmitter, ConnectionState, OutEvent};
    use crate::store::Kind;
    use k8s_openapi::api::core::v1::{ConfigMap, Pod};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use std::time::Duration;
    use tokio::time::timeout;

    fn cm(name: &str) -> Object {
        Object::ConfigMap(ConfigMap { metadata: ObjectMeta { name: Some(name.into()), namespace: Some("n".into()), ..Default::default() }, ..Default::default() })
    }
    fn pod(name: &str) -> Object {
        Object::Pod(Pod { metadata: ObjectMeta { name: Some(name.into()), namespace: Some("n".into()), ..Default::default() }, ..Default::default() })
    }

    fn fast_config(kinds: &[Kind]) -> ReducerConfig {
        ReducerConfig { kinds: kinds.to_vec(), debounce: Duration::from_millis(20), degraded_after: Duration::from_millis(50), tick: Duration::from_millis(10) }
    }

    async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<OutEvent>) -> OutEvent {
        timeout(Duration::from_secs(2), rx.recv()).await.expect("event in time").expect("channel open")
    }

    #[tokio::test]
    async fn snapshot_only_after_all_kinds_init_done() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, handle) = spawn_reducer(fast_config(&[Kind::ConfigMap, Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::Applied(cm("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::ConfigMap))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(rx.try_recv().is_err(), "nothing before every kind is initialised");
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphSnapshot(g) => assert_eq!(g.nodes.len(), 1),
            other => panic!("expected snapshot, got {other:?}"),
        }
        drop(tx);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn changes_after_snapshot_are_debounced_into_one_delta() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("b")))).await.unwrap();
        match next(&mut rx).await {
            OutEvent::GraphDelta(d) => {
                assert_eq!(d.added_nodes.len(), 2);
                assert!(d.removed_nodes.is_empty());
            }
            other => panic!("expected delta, got {other:?}"),
        }
        // Re-applying identical objects produces no delta.
        tx.send(ReducerMsg::Store(StoreEvent::Applied(pod("a")))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(rx.try_recv().is_err());
        assert_eq!(shared.graph.lock().unwrap().nodes.len(), 2);
    }

    #[tokio::test]
    async fn fatal_failure_counts_as_init_done_and_reports_error() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Secret, Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::Failed { kind: Kind::Secret, error: AppError::new(ErrorKind::Forbidden, "no"), fatal: true })).await.unwrap();
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::ConnectionError(_)));
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        assert!(shared.denied_kinds.lock().unwrap().contains(&Kind::Secret));
    }

    #[tokio::test]
    async fn prolonged_error_degrades_then_recovers_with_snapshot() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        tx.send(ReducerMsg::Store(StoreEvent::Failed { kind: Kind::Pod, error: AppError::new(ErrorKind::Network, "eof"), fatal: false })).await.unwrap();
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Degraded));
        tx.send(ReducerMsg::Store(StoreEvent::Recovered(Kind::Pod))).await.unwrap();
        assert_eq!(next(&mut rx).await, OutEvent::ConnectionState(ConnectionState::Connected));
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
    }

    #[tokio::test]
    async fn rebuild_message_forces_immediate_rebuild() {
        let (emitter, mut rx) = ChannelEmitter::new();
        let shared = Shared::default();
        let (tx, _h) = spawn_reducer(fast_config(&[Kind::Pod]), shared.clone(), Arc::new(emitter));
        tx.send(ReducerMsg::Store(StoreEvent::InitDone(Kind::Pod))).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphSnapshot(_)));
        shared.store.lock().unwrap().upsert(pod("x")); // simulate an external change
        tx.send(ReducerMsg::Rebuild).await.unwrap();
        assert!(matches!(next(&mut rx).await, OutEvent::GraphDelta(_)));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test session::reducer 2>&1 | tail -5`
Expected: compile error — module not found.

- [ ] **Step 3: Implement** `src-tauri/src/session/reducer.rs`

```rust
//! Consumes StoreEvents, keeps the Store and last Graph, emits snapshots/deltas.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::emitter::{ConnectionState, Emitter, OutEvent};
use super::watch::StoreEvent;
use crate::error::{AppError, ErrorKind};
use crate::graph::{build, diff, BuildOptions, Graph, NodeId};
use crate::store::{Kind, Object, Store};

#[derive(Debug)]
pub enum ReducerMsg {
    Store(StoreEvent),
    /// Options changed (expanded groups) — rebuild now.
    Rebuild,
}

#[derive(Debug, Clone)]
pub struct ReducerConfig {
    pub kinds: Vec<Kind>,
    pub debounce: Duration,
    pub degraded_after: Duration,
    pub tick: Duration,
}

impl Default for ReducerConfig {
    fn default() -> Self {
        Self {
            kinds: Kind::WATCHED.to_vec(),
            debounce: Duration::from_millis(150),
            degraded_after: Duration::from_secs(30),
            tick: Duration::from_secs(5),
        }
    }
}

/// State shared between the reducer task and `Session` (for get_object etc.).
#[derive(Default, Clone)]
pub struct Shared {
    pub store: Arc<Mutex<Store>>,
    pub graph: Arc<Mutex<Graph>>,
    pub expanded_groups: Arc<Mutex<HashSet<NodeId>>>,
    pub denied_kinds: Arc<Mutex<HashSet<Kind>>>,
}

impl Shared {
    fn build_options(&self) -> BuildOptions {
        BuildOptions { expanded_groups: self.expanded_groups.lock().unwrap().clone(), ..Default::default() }
    }

    /// Rebuild from the store; returns (new graph, delta vs previous).
    fn rebuild(&self) -> (Graph, crate::graph::GraphDelta) {
        let new = build(&self.store.lock().unwrap(), &self.build_options());
        let mut last = self.graph.lock().unwrap();
        let delta = diff(&last, &new);
        *last = new.clone();
        (new, delta)
    }
}

pub fn spawn_reducer(config: ReducerConfig, shared: Shared, emitter: Arc<dyn Emitter>) -> (mpsc::Sender<ReducerMsg>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel(1024);
    let handle = tokio::spawn(run(config, shared, emitter, rx));
    (tx, handle)
}

async fn run(config: ReducerConfig, shared: Shared, emitter: Arc<dyn Emitter>, mut rx: mpsc::Receiver<ReducerMsg>) {
    let mut init_pending: HashSet<Kind> = config.kinds.iter().copied().collect();
    let mut initialised = false;
    let mut flush_at: Option<Instant> = None;
    let mut errored_since: HashMap<Kind, Instant> = HashMap::new();
    let mut state = ConnectionState::Connected;
    let mut ticker = tokio::time::interval(config.tick);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        let flush = async move {
            match flush_at {
                Some(at) => tokio::time::sleep_until(at.into()).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { break };
                match msg {
                    ReducerMsg::Rebuild => {
                        if initialised {
                            flush_at = None;
                            emit_rebuild(&shared, &emitter);
                        }
                    }
                    ReducerMsg::Store(ev) => {
                        let changed = apply(&shared, ev, &mut init_pending, &mut errored_since, &emitter);
                        if !initialised && init_pending.is_empty() {
                            initialised = true;
                            flush_at = None;
                            let (graph, _) = shared.rebuild();
                            emitter.emit(OutEvent::GraphSnapshot(graph));
                        } else if initialised && changed && flush_at.is_none() {
                            flush_at = Some(Instant::now() + config.debounce);
                        }
                    }
                }
            }
            _ = flush => {
                flush_at = None;
                emit_rebuild(&shared, &emitter);
            }
            _ = ticker.tick() => {
                let now = Instant::now();
                let degraded = errored_since.values().any(|since| now.duration_since(*since) >= config.degraded_after);
                let next = if degraded { ConnectionState::Degraded } else { ConnectionState::Connected };
                if next != state {
                    state = next;
                    emitter.emit(OutEvent::ConnectionState(state));
                    if state == ConnectionState::Connected && initialised {
                        let (graph, _) = shared.rebuild();
                        emitter.emit(OutEvent::GraphSnapshot(graph));
                    }
                }
            }
        }
    }
}

fn emit_rebuild(shared: &Shared, emitter: &Arc<dyn Emitter>) {
    let (_, delta) = shared.rebuild();
    if !delta.is_empty() {
        emitter.emit(OutEvent::GraphDelta(delta));
    }
}

/// Apply one event. Returns true when the store content may have changed.
fn apply(
    shared: &Shared,
    ev: StoreEvent,
    init_pending: &mut HashSet<Kind>,
    errored_since: &mut HashMap<Kind, Instant>,
    emitter: &Arc<dyn Emitter>,
) -> bool {
    match ev {
        StoreEvent::Applied(obj) => {
            let kind = obj.kind();
            errored_since.remove(&kind);
            upsert_if_changed(&shared.store, obj)
        }
        StoreEvent::Deleted(key) => {
            errored_since.remove(&key.kind);
            shared.store.lock().unwrap().remove(&key).is_some()
        }
        StoreEvent::InitDone(kind) => {
            errored_since.remove(&kind);
            init_pending.remove(&kind);
            false
        }
        StoreEvent::Recovered(kind) => {
            errored_since.remove(&kind);
            false
        }
        StoreEvent::Failed { kind, error, fatal } => {
            if fatal {
                init_pending.remove(&kind);
                errored_since.remove(&kind);
                shared.denied_kinds.lock().unwrap().insert(kind);
                emitter.emit(OutEvent::ConnectionError(AppError::new(
                    ErrorKind::Forbidden,
                    format!("{}: {}", kind.as_str(), error.message),
                )));
            } else {
                errored_since.entry(kind).or_insert_with(Instant::now);
            }
            false
        }
    }
}

/// Skip no-op updates (resourceVersion bumps without content change still count as changed —
/// the graph diff filters those out cheaply).
fn upsert_if_changed(store: &Arc<Mutex<Store>>, obj: Object) -> bool {
    let mut store = store.lock().unwrap();
    let key = obj.key();
    let same = store
        .get(&key)
        .map(|existing| existing.to_json_value() == obj.to_json_value())
        .unwrap_or(false);
    if same {
        return false;
    }
    store.upsert(obj);
    true
}
```

Add `pub mod reducer;` to `src-tauri/src/session/mod.rs`.

- [ ] **Step 4: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test session::reducer 2>&1 | tail -8`
Expected: `test result: ok. 5 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Add reducer: debounce, snapshot/delta emission, degraded detection"
```

---

### Task 12: `Session` — connect, namespace, object details, per-object events

**Files:**
- Create: `src-tauri/src/session/session.rs` (rename-free: keep in `session/mod.rs` instead — see below)
- Modify: `src-tauri/src/session/mod.rs`

Put the `Session` struct directly in `src-tauri/src/session/mod.rs`. Unit tests here cover the pure helpers (`parse_node_id`, `object_details`, `events_to_list`); connecting is covered by the smoke test in Task 14.

- [ ] **Step 1: Write the failing tests** (bottom of `src-tauri/src/session/mod.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Kind, Store};

    #[test]
    fn parses_node_ids() {
        assert_eq!(parse_node_id("Pod/payments/web-1").unwrap(), (Kind::Pod, Some("payments".to_string()), "web-1".to_string()));
        assert_eq!(parse_node_id("PersistentVolume//pv-1").unwrap(), (Kind::PersistentVolume, None, "pv-1".to_string()));
        assert_eq!(parse_node_id("PodGroup/g/Deployment/api").unwrap(), (Kind::PodGroup, Some("g".to_string()), "Deployment/api".to_string()));
        assert!(parse_node_id("garbage").is_err());
        assert!(parse_node_id("Node/x/y").is_err());
    }

    #[test]
    fn object_details_has_yaml_summary_and_related() {
        let store = Store::from_fixture("deployment-basic").unwrap();
        let graph = crate::graph::build(&store, &Default::default());
        let d = object_details(&store, &graph, "Deployment/payments/web").unwrap();
        assert!(d.yaml.starts_with("apiVersion: apps/v1\nkind: Deployment\n"), "{}", d.yaml);
        assert!(!d.yaml.contains("managedFields"));
        assert!(d.summary.iter().any(|(k, _)| k == "Replicas"));
        assert_eq!(d.related, vec!["Pod/payments/web-7f9c-aaaaa", "Pod/payments/web-7f9c-bbbbb"]);
    }

    #[test]
    fn pod_group_details_come_from_graph_node() {
        let store = Store::from_fixture("podgroup").unwrap();
        let graph = crate::graph::build(&store, &Default::default());
        let d = object_details(&store, &graph, "PodGroup/g/Deployment/api").unwrap();
        assert_eq!(d.yaml, "");
        assert!(d.summary.iter().any(|(k, v)| k == "Pods" && v == "7"));
        assert!(d.related.contains(&"Deployment/g/api".to_string()));
    }

    #[test]
    fn missing_object_is_not_found() {
        let store = Store::default();
        let err = object_details(&store, &Graph::default(), "Pod/a/b").unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
    }

    #[test]
    fn events_are_sorted_newest_first() {
        use k8s_openapi::api::core::v1::Event;
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time};
        let mk = |name: &str, ts: &str| Event {
            metadata: ObjectMeta { name: Some(name.into()), ..Default::default() },
            type_: Some("Warning".into()),
            reason: Some("BackOff".into()),
            message: Some("restarting".into()),
            count: Some(3),
            last_timestamp: Some(Time(ts.parse().unwrap())),
            ..Default::default()
        };
        let mut map = std::collections::BTreeMap::new();
        map.insert("old".to_string(), mk("old", "2026-09-17T09:00:00Z"));
        map.insert("new".to_string(), mk("new", "2026-09-17T10:00:00Z"));
        let list = events_to_list(&map);
        assert_eq!(list.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["new", "old"]);
        assert_eq!(list[0].type_, "Warning");
        assert_eq!(list[0].count, 3);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test session::tests 2>&1 | tail -5`
Expected: compile error — functions not found.

- [ ] **Step 3: Implement** — replace `src-tauri/src/session/mod.rs` with:

```rust
//! One live connection to a cluster: watchers, store, graph, events.

pub mod emitter;
pub mod reducer;
pub mod watch;

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use futures::StreamExt;
use k8s_openapi::api::core::v1::{Event as CoreEvent, Namespace};
use kube::api::{Api, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::runtime::watcher::{self, Event};
use kube::runtime::WatchStreamExt;
use kube::{Client, Config};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::{status::summary, Graph, NodeId};
use crate::store::{Kind, Store};
use emitter::{Emitter, K8sEvent, ObjectEvents, OutEvent};
use reducer::{spawn_reducer, ReducerConfig, ReducerMsg, Shared};
use watch::{app_error_from_kube, spawn_all};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub context: String,
    pub server_version: String,
    pub namespaces: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetails {
    pub yaml: String,
    pub summary: Vec<(String, String)>,
    pub related: Vec<NodeId>,
}

pub struct Session {
    client: Client,
    context: String,
    namespace: Option<String>,
    shared: Shared,
    emitter: Arc<dyn Emitter>,
    reducer_tx: Option<mpsc::Sender<ReducerMsg>>,
    tasks: Vec<JoinHandle<()>>,
    events_task: Option<JoinHandle<()>>,
}

impl Session {
    pub async fn connect(kubeconfig: Kubeconfig, context: &str, emitter: Arc<dyn Emitter>) -> AppResult<(Session, ConnectInfo)> {
        let options = KubeConfigOptions { context: Some(context.to_string()), cluster: None, user: None };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| AppError::new(ErrorKind::Auth, e.to_string()))?;
        let client = Client::try_from(config).map_err(|e| AppError::new(ErrorKind::Internal, e.to_string()))?;

        let version = client.apiserver_version().await.map_err(|e| app_error_from_kube(&e))?;
        let namespaces = Api::<Namespace>::all(client.clone())
            .list(&ListParams::default())
            .await
            .map_err(|e| app_error_from_kube(&e))?
            .items
            .into_iter()
            .filter_map(|n| n.metadata.name)
            .collect::<Vec<_>>();

        let info = ConnectInfo { context: context.to_string(), server_version: version.git_version, namespaces };
        let session = Session {
            client,
            context: context.to_string(),
            namespace: None,
            shared: Shared::default(),
            emitter,
            reducer_tx: None,
            tasks: vec![],
            events_task: None,
        };
        Ok((session, info))
    }

    pub fn context(&self) -> &str {
        &self.context
    }

    pub fn namespace(&self) -> Option<&str> {
        self.namespace.as_deref()
    }

    pub fn denied_kinds(&self) -> Vec<Kind> {
        let mut v: Vec<Kind> = self.shared.denied_kinds.lock().unwrap().iter().copied().collect();
        v.sort();
        v
    }

    /// Tear down any previous watchers and start watching `namespace`.
    pub async fn select_namespace(&mut self, namespace: &str, expanded_groups: HashSet<NodeId>) -> AppResult<()> {
        self.stop_watchers();
        self.shared = Shared::default();
        *self.shared.expanded_groups.lock().unwrap() = expanded_groups;
        self.namespace = Some(namespace.to_string());

        let (reducer_tx, reducer_task) = spawn_reducer(ReducerConfig::default(), self.shared.clone(), self.emitter.clone());
        let (store_tx, mut store_rx) = mpsc::channel(4096);
        // Bridge StoreEvent -> ReducerMsg so watchers do not know about the reducer.
        let bridge_tx = reducer_tx.clone();
        let bridge = tokio::spawn(async move {
            while let Some(ev) = store_rx.recv().await {
                if bridge_tx.send(ReducerMsg::Store(ev)).await.is_err() {
                    break;
                }
            }
        });
        self.tasks = spawn_all(&self.client, namespace, &store_tx);
        self.tasks.push(bridge);
        self.tasks.push(reducer_task);
        self.reducer_tx = Some(reducer_tx);
        Ok(())
    }

    pub async fn set_expanded_groups(&mut self, expanded_groups: HashSet<NodeId>) -> AppResult<()> {
        *self.shared.expanded_groups.lock().unwrap() = expanded_groups;
        if let Some(tx) = &self.reducer_tx {
            tx.send(ReducerMsg::Rebuild).await.map_err(|_| AppError::internal("reducer stopped"))?;
        }
        Ok(())
    }

    pub fn get_object(&self, node_id: &str) -> AppResult<ObjectDetails> {
        let store = self.shared.store.lock().unwrap();
        let graph = self.shared.graph.lock().unwrap();
        object_details(&store, &graph, node_id)
    }

    /// Watch core/v1 Events for one object (or stop when `None`).
    pub async fn watch_events(&mut self, node_id: Option<&str>) -> AppResult<()> {
        if let Some(t) = self.events_task.take() {
            t.abort();
        }
        let Some(node_id) = node_id else { return Ok(()) };
        let (kind, ns, name) = parse_node_id(node_id)?;
        if kind == Kind::PodGroup {
            return Ok(());
        }
        let uid = {
            let store = self.shared.store.lock().unwrap();
            store
                .find(kind, ns.as_deref(), &name)
                .and_then(|o| o.uid().map(str::to_owned))
                .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in store")))?
        };
        let api: Api<CoreEvent> = match ns.as_deref().or(self.namespace.as_deref()) {
            Some(ns) => Api::namespaced(self.client.clone(), ns),
            None => Api::all(self.client.clone()),
        };
        let emitter = self.emitter.clone();
        let node_id = node_id.to_string();
        self.events_task = Some(tokio::spawn(async move {
            let cfg = watcher::Config::default().fields(&format!("involvedObject.uid={uid}"));
            let mut stream = watcher(api, cfg).default_backoff().boxed();
            let mut events: BTreeMap<String, CoreEvent> = BTreeMap::new();
            while let Some(item) = stream.next().await {
                match item {
                    Ok(Event::Init) => events.clear(),
                    Ok(Event::InitApply(e)) | Ok(Event::Apply(e)) => {
                        events.insert(e.metadata.name.clone().unwrap_or_default(), e);
                    }
                    Ok(Event::Delete(e)) => {
                        events.remove(&e.metadata.name.clone().unwrap_or_default());
                    }
                    Ok(Event::InitDone) => {}
                    Err(e) => {
                        tracing::warn!(error = %e, "events watcher error");
                        continue;
                    }
                }
                emitter.emit(OutEvent::ObjectEvents(ObjectEvents { node_id: node_id.clone(), events: events_to_list(&events) }));
            }
        }));
        Ok(())
    }

    fn stop_watchers(&mut self) {
        for t in self.tasks.drain(..) {
            t.abort();
        }
        if let Some(t) = self.events_task.take() {
            t.abort();
        }
        self.reducer_tx = None;
    }

    pub fn shutdown(&mut self) {
        self.stop_watchers();
        self.emitter.emit(OutEvent::ConnectionState(emitter::ConnectionState::Disconnected));
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop_watchers();
    }
}

/// `"Kind/ns/name"`; cluster-scoped `"Kind//name"`; PodGroup `"PodGroup/ns/OwnerKind/ownerName"`.
pub fn parse_node_id(id: &str) -> AppResult<(Kind, Option<String>, String)> {
    let mut parts = id.splitn(3, '/');
    let (Some(kind), Some(ns), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(AppError::new(ErrorKind::NotFound, format!("malformed node id `{id}`")));
    };
    let kind = if kind == "PodGroup" { Kind::PodGroup } else {
        Kind::parse(kind).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("unknown kind in `{id}`")))?
    };
    let ns = if ns.is_empty() { None } else { Some(ns.to_string()) };
    Ok((kind, ns, name.to_string()))
}

pub fn object_details(store: &Store, graph: &Graph, node_id: &str) -> AppResult<ObjectDetails> {
    let (kind, ns, name) = parse_node_id(node_id)?;
    let related: Vec<NodeId> = {
        let mut r: Vec<NodeId> = graph
            .edges_touching(node_id)
            .map(|e| if e.source == node_id { e.target.clone() } else { e.source.clone() })
            .collect();
        r.sort();
        r.dedup();
        r
    };
    if kind == Kind::PodGroup {
        let node = graph.node(node_id).ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in graph")))?;
        let info = node.group.clone().unwrap_or(crate::graph::GroupInfo { count: 0, ok: 0, warn: 0, err: 0 });
        let summary = vec![
            ("Owner".to_string(), name),
            ("Namespace".to_string(), ns.unwrap_or_default()),
            ("Pods".to_string(), info.count.to_string()),
            ("Ok".to_string(), info.ok.to_string()),
            ("Warning".to_string(), info.warn.to_string()),
            ("Error".to_string(), info.err.to_string()),
        ];
        return Ok(ObjectDetails { yaml: String::new(), summary, related });
    }
    let obj = store
        .find(kind, ns.as_deref(), &name)
        .ok_or_else(|| AppError::new(ErrorKind::NotFound, format!("{node_id} not in store")))?;
    let yaml = serde_yaml_ng::to_string(&obj.to_json_value()).map_err(|e| AppError::internal(e.to_string()))?;
    Ok(ObjectDetails { yaml, summary: summary(obj), related })
}

pub fn events_to_list(events: &BTreeMap<String, CoreEvent>) -> Vec<K8sEvent> {
    let mut list: Vec<(Option<String>, K8sEvent)> = events
        .values()
        .map(|e| {
            let last = e.last_timestamp.as_ref().map(|t| t.0.to_rfc3339()).or_else(|| e.event_time.as_ref().map(|t| t.0.to_rfc3339()));
            let ev = K8sEvent {
                name: e.metadata.name.clone().unwrap_or_default(),
                type_: e.type_.clone().unwrap_or_else(|| "Normal".into()),
                reason: e.reason.clone().unwrap_or_default(),
                message: e.message.clone().unwrap_or_default(),
                count: e.count.unwrap_or(1),
                first_timestamp: e.first_timestamp.as_ref().map(|t| t.0.to_rfc3339()),
                last_timestamp: last.clone(),
            };
            (last, ev)
        })
        .collect();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    list.into_iter().map(|(_, e)| e).collect()
}
```

Note: `serde_yaml_ng::to_string` on a `serde_json::Value` emits keys in the JSON object's order; `serde_json`'s `preserve_order` feature (already enabled in `Cargo.toml` from Task 1) keeps `apiVersion`/`kind` first as the test expects.

- [ ] **Step 4: Run tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test session:: 2>&1 | tail -8`
Expected: all session tests pass (`13 passed` total across emitter/watch/reducer/session).

- [ ] **Step 5: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Add Session: connect, namespace watchers, object details, per-object events"
```

---

### Task 13: Tauri commands, app state, IPC fixtures

**Files:**
- Create: `src-tauri/src/commands.rs`, `src-tauri/tests/ipc_fixtures.rs`
- Create: `src/shared/ipc/fixtures/{context_info,connect_info,graph,graph_delta,object_details,object_events,connection_state,app_error}.json`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`

- [ ] **Step 1: Write the IPC fixture files** (these are the contract the TypeScript side mirrors)

`src/shared/ipc/fixtures/context_info.json`
```json
{
  "name": "prod-eu",
  "cluster": "prod-eu-cluster",
  "user": "alice",
  "namespace": "payments",
  "sourceFile": "/Users/alice/.kube/config"
}
```

`src/shared/ipc/fixtures/connect_info.json`
```json
{
  "context": "prod-eu",
  "serverVersion": "v1.33.2",
  "namespaces": ["default", "kube-system", "payments"]
}
```

`src/shared/ipc/fixtures/graph.json`
```json
{
  "nodes": [
    {
      "id": "Deployment/payments/web",
      "kind": "Deployment",
      "namespace": "payments",
      "name": "web",
      "status": "ok",
      "badges": ["3/3", "nginx:1.27"],
      "group": null
    },
    {
      "id": "PodGroup/payments/Deployment/web",
      "kind": "PodGroup",
      "namespace": "payments",
      "name": "web",
      "status": "err",
      "badges": ["×7", "6 ok · 1 err"],
      "group": { "count": 7, "ok": 6, "warn": 0, "err": 1 }
    }
  ],
  "edges": [
    {
      "id": "Deployment/payments/web->PodGroup/payments/Deployment/web:owns",
      "source": "Deployment/payments/web",
      "target": "PodGroup/payments/Deployment/web",
      "relation": "owns"
    }
  ]
}
```

`src/shared/ipc/fixtures/graph_delta.json`
```json
{
  "addedNodes": [
    {
      "id": "Pod/payments/web-1",
      "kind": "Pod",
      "namespace": "payments",
      "name": "web-1",
      "status": "warn",
      "badges": ["Pending"],
      "group": null
    }
  ],
  "updatedNodes": [],
  "removedNodes": ["Pod/payments/web-0"],
  "addedEdges": [
    {
      "id": "ServiceAccount/payments/default->Pod/payments/web-1:usesSA",
      "source": "ServiceAccount/payments/default",
      "target": "Pod/payments/web-1",
      "relation": "usesSA"
    }
  ],
  "removedEdges": ["ServiceAccount/payments/default->Pod/payments/web-0:usesSA"]
}
```

`src/shared/ipc/fixtures/object_details.json`
```json
{
  "yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n",
  "summary": [["Name", "cfg"], ["Kind", "ConfigMap"]],
  "related": ["Pod/payments/web-1"]
}
```

`src/shared/ipc/fixtures/object_events.json`
```json
{
  "nodeId": "Pod/payments/web-1",
  "events": [
    {
      "name": "web-1.17f2a",
      "type": "Warning",
      "reason": "BackOff",
      "message": "Back-off restarting failed container",
      "count": 14,
      "firstTimestamp": "2026-09-17T10:00:00+00:00",
      "lastTimestamp": "2026-09-17T10:20:00+00:00"
    }
  ]
}
```

`src/shared/ipc/fixtures/connection_state.json`
```json
"degraded"
```

`src/shared/ipc/fixtures/app_error.json`
```json
{ "kind": "forbidden", "message": "secrets is forbidden" }
```

- [ ] **Step 2: Write the failing fixture test** `src-tauri/tests/ipc_fixtures.rs`

```rust
//! Guards the IPC contract: every payload type serializes exactly like the committed
//! JSON fixtures that the TypeScript types in src/shared/ipc mirror.

use std::path::PathBuf;

use serde::Serialize;
use wiring_lib::error::{AppError, ErrorKind};
use wiring_lib::graph::{Edge, Graph, GraphDelta, GroupInfo, Node, Relation, Status};
use wiring_lib::kubeconfig::ContextInfo;
use wiring_lib::session::emitter::{ConnectionState, K8sEvent, ObjectEvents};
use wiring_lib::session::{ConnectInfo, ObjectDetails};
use wiring_lib::store::Kind;

fn fixture(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/shared/ipc/fixtures").join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn assert_matches<T: Serialize>(name: &str, value: &T) {
    let actual = serde_json::to_value(value).unwrap();
    let expected = fixture(name);
    assert_eq!(actual, expected, "fixture {name}.json drifted from the Rust type");
}

fn node(id: &str, kind: Kind, name: &str, status: Status, badges: &[&str], group: Option<GroupInfo>) -> Node {
    Node { id: id.into(), kind, namespace: Some("payments".into()), name: name.into(), status, badges: badges.iter().map(|s| s.to_string()).collect(), group }
}

#[test]
fn context_info() {
    assert_matches("context_info", &ContextInfo {
        name: "prod-eu".into(), cluster: "prod-eu-cluster".into(), user: "alice".into(),
        namespace: Some("payments".into()), source_file: "/Users/alice/.kube/config".into(),
    });
}

#[test]
fn connect_info() {
    assert_matches("connect_info", &ConnectInfo {
        context: "prod-eu".into(), server_version: "v1.33.2".into(),
        namespaces: vec!["default".into(), "kube-system".into(), "payments".into()],
    });
}

#[test]
fn graph() {
    let g = Graph {
        nodes: vec![
            node("Deployment/payments/web", Kind::Deployment, "web", Status::Ok, &["3/3", "nginx:1.27"], None),
            node("PodGroup/payments/Deployment/web", Kind::PodGroup, "web", Status::Err, &["×7", "6 ok · 1 err"], Some(GroupInfo { count: 7, ok: 6, warn: 0, err: 1 })),
        ],
        edges: vec![Edge::new("Deployment/payments/web", "PodGroup/payments/Deployment/web", Relation::Owns)],
    };
    assert_matches("graph", &g);
}

#[test]
fn graph_delta() {
    let d = GraphDelta {
        added_nodes: vec![node("Pod/payments/web-1", Kind::Pod, "web-1", Status::Warn, &["Pending"], None)],
        updated_nodes: vec![],
        removed_nodes: vec!["Pod/payments/web-0".into()],
        added_edges: vec![Edge::new("ServiceAccount/payments/default", "Pod/payments/web-1", Relation::UsesSa)],
        removed_edges: vec!["ServiceAccount/payments/default->Pod/payments/web-0:usesSA".into()],
    };
    assert_matches("graph_delta", &d);
}

#[test]
fn object_details() {
    assert_matches("object_details", &ObjectDetails {
        yaml: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n".into(),
        summary: vec![("Name".into(), "cfg".into()), ("Kind".into(), "ConfigMap".into())],
        related: vec!["Pod/payments/web-1".into()],
    });
}

#[test]
fn object_events() {
    assert_matches("object_events", &ObjectEvents {
        node_id: "Pod/payments/web-1".into(),
        events: vec![K8sEvent {
            name: "web-1.17f2a".into(), type_: "Warning".into(), reason: "BackOff".into(),
            message: "Back-off restarting failed container".into(), count: 14,
            first_timestamp: Some("2026-09-17T10:00:00+00:00".into()), last_timestamp: Some("2026-09-17T10:20:00+00:00".into()),
        }],
    });
}

#[test]
fn connection_state_and_error() {
    assert_matches("connection_state", &ConnectionState::Degraded);
    assert_matches("app_error", &AppError::new(ErrorKind::Forbidden, "secrets is forbidden"));
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo test --test ipc_fixtures 2>&1 | tail -5`
Expected: compiles and passes already if Tasks 4–12 are correct — if any assertion fails, the **Rust type** is wrong (rename fields to match the fixture), not the fixture.

- [ ] **Step 4: Implement commands** `src-tauri/src/commands.rs`

```rust
//! Tauri command layer: thin wrappers over kubeconfig + Session.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter as TauriEmit, State};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::kubeconfig::{self, ContextInfo};
use crate::session::emitter::{Emitter, OutEvent};
use crate::session::{ConnectInfo, ObjectDetails, Session};
use crate::store::Kind;

const SETTINGS_FILE: &str = "settings.json";
const KEY_EXTRA_KUBECONFIGS: &str = "extraKubeconfigs";

pub struct TauriEmitter(pub AppHandle);

impl Emitter for TauriEmitter {
    fn emit(&self, event: OutEvent) {
        let (name, payload) = event.into_parts();
        if let Err(e) = self.0.emit(name, payload) {
            tracing::warn!(event = name, error = %e, "failed to emit");
        }
    }
}

#[derive(Default)]
pub struct AppState {
    pub session: Mutex<Option<Session>>,
}

fn extra_kubeconfigs(app: &AppHandle) -> Vec<PathBuf> {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|s| s.get(KEY_EXTRA_KUBECONFIGS))
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

fn all_kubeconfig_paths(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths = kubeconfig::default_paths();
    paths.extend(extra_kubeconfigs(app));
    paths
}

#[tauri::command]
pub fn list_contexts(app: AppHandle) -> AppResult<Vec<ContextInfo>> {
    kubeconfig::list_contexts(&all_kubeconfig_paths(&app))
}

#[tauri::command]
pub fn add_kubeconfig(app: AppHandle, path: String) -> AppResult<Vec<ContextInfo>> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::new(ErrorKind::NotFound, format!("{path} does not exist")));
    }
    let mut extra = extra_kubeconfigs(&app);
    if !extra.contains(&p) {
        extra.push(p);
    }
    let store = app.store(SETTINGS_FILE).map_err(|e| AppError::internal(e.to_string()))?;
    store.set(KEY_EXTRA_KUBECONFIGS, json!(kubeconfig::path_strings(&extra)));
    store.save().map_err(|e| AppError::internal(e.to_string()))?;
    list_contexts(app)
}

#[tauri::command]
pub async fn connect(app: AppHandle, state: State<'_, AppState>, context: String) -> AppResult<ConnectInfo> {
    let merged = kubeconfig::load_merged(&all_kubeconfig_paths(&app))?;
    let emitter: Arc<dyn Emitter> = Arc::new(TauriEmitter(app.clone()));
    let (session, info) = Session::connect(merged, &context, emitter).await?;
    let mut guard = state.session.lock().await;
    if let Some(mut old) = guard.take() {
        old.shutdown();
    }
    *guard = Some(session);
    let _ = app.emit("connection_state", "connected");
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> AppResult<()> {
    if let Some(mut s) = state.session.lock().await.take() {
        s.shutdown();
    }
    Ok(())
}

async fn with_session<T>(state: &State<'_, AppState>, f: impl FnOnce(&mut Session) -> AppResult<T>) -> AppResult<T> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or_else(|| AppError::new(ErrorKind::Internal, "not connected"))?;
    f(session)
}

#[tauri::command]
pub async fn select_namespace(state: State<'_, AppState>, namespace: String, expanded_groups: Vec<String>) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or_else(|| AppError::new(ErrorKind::Internal, "not connected"))?;
    session.select_namespace(&namespace, expanded_groups.into_iter().collect::<HashSet<_>>()).await
}

#[tauri::command]
pub async fn set_expanded_groups(state: State<'_, AppState>, expanded_groups: Vec<String>) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or_else(|| AppError::new(ErrorKind::Internal, "not connected"))?;
    session.set_expanded_groups(expanded_groups.into_iter().collect::<HashSet<_>>()).await
}

#[tauri::command]
pub async fn get_object(state: State<'_, AppState>, node_id: String) -> AppResult<ObjectDetails> {
    with_session(&state, |s| s.get_object(&node_id)).await
}

#[tauri::command]
pub async fn watch_events(state: State<'_, AppState>, node_id: Option<String>) -> AppResult<()> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or_else(|| AppError::new(ErrorKind::Internal, "not connected"))?;
    session.watch_events(node_id.as_deref()).await
}

#[tauri::command]
pub async fn denied_kinds(state: State<'_, AppState>) -> AppResult<Vec<Kind>> {
    with_session(&state, |s| Ok(s.denied_kinds())).await
}

pub fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.manage(AppState::default()).invoke_handler(tauri::generate_handler![
        list_contexts,
        add_kubeconfig,
        connect,
        disconnect,
        select_namespace,
        set_expanded_groups,
        get_object,
        watch_events,
        denied_kinds,
    ])
}
```

Replace `src-tauri/src/lib.rs` with:
```rust
pub mod commands;
pub mod error;
pub mod graph;
pub mod kubeconfig;
pub mod session;
pub mod store;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,wiring_lib=debug".into()))
        .init();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init());

    commands::register(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Replace `src-tauri/capabilities/default.json` with:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Wiring main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:window:allow-start-dragging",
    "store:default",
    "dialog:allow-open"
  ]
}
```

- [ ] **Step 5: Build, run all tests**

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo build 2>&1 | grep -E "^(warning|error)" | sort | uniq -c; cargo test 2>&1 | grep -E "^test result|FAILED|panicked"`
Expected: no `error` lines; every `test result: ok`. If `tauri::Emitter` conflicts with our `Emitter` trait name, the `use tauri::Emitter as TauriEmit` alias above already avoids it — call sites use `app.emit(...)` which resolves through the alias.

- [ ] **Step 6: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Wire Tauri commands, app state and IPC contract fixtures"
```

---

### Task 14: Headless smoke test against a real cluster

**Files:**
- Create: `src-tauri/tests/smoke.rs`, `src-tauri/tests/fixtures/smoke.yaml`

Runs only when `WIRING_SMOKE_CONTEXT` is set (e.g. `docker-desktop` locally, `kind-kind` in CI). Requires `kubectl` on PATH.

- [ ] **Step 1: Write the fixture** `src-tauri/tests/fixtures/smoke.yaml`

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: wiring-smoke }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: web-cfg, namespace: wiring-smoke }
data: { GREETING: hello }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: wiring-smoke }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: registry.k8s.io/pause:3.9
          envFrom: [ { configMapRef: { name: web-cfg } } ]
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: wiring-smoke }
spec: { selector: { app: web }, ports: [ { port: 80, targetPort: 80 } ] }
```

- [ ] **Step 2: Write the test** `src-tauri/tests/smoke.rs`

```rust
//! End-to-end: apply a fixture namespace, run a headless Session, assert the graph.
//! Run: WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored --nocapture

use std::collections::HashSet;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use wiring_lib::kubeconfig;
use wiring_lib::session::emitter::{ChannelEmitter, OutEvent};
use wiring_lib::session::Session;

fn kubectl(context: &str, args: &[&str]) {
    let status = Command::new("kubectl").arg("--context").arg(context).args(args).status().expect("kubectl on PATH");
    assert!(status.success(), "kubectl {args:?} failed");
}

#[tokio::test]
#[ignore]
async fn graph_snapshot_reflects_applied_fixture() {
    let context = std::env::var("WIRING_SMOKE_CONTEXT").expect("set WIRING_SMOKE_CONTEXT");
    let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/smoke.yaml");
    kubectl(&context, &["apply", "-f", fixture]);

    let merged = kubeconfig::load_merged(&kubeconfig::default_paths()).unwrap();
    let (emitter, mut rx) = ChannelEmitter::new();
    let (mut session, info) = Session::connect(merged, &context, Arc::new(emitter)).await.unwrap();
    assert!(info.namespaces.contains(&"wiring-smoke".to_string()));
    session.select_namespace("wiring-smoke", HashSet::new()).await.unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let graph = loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("snapshot before deadline").expect("emitter open");
        match ev {
            OutEvent::GraphSnapshot(g) => break g,
            OutEvent::ConnectionError(e) => panic!("connection error: {e:?}"),
            _ => continue,
        }
    };

    let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    assert!(ids.contains(&"Deployment/wiring-smoke/web"), "{ids:?}");
    assert!(ids.contains(&"Service/wiring-smoke/web"), "{ids:?}");
    assert!(ids.contains(&"ConfigMap/wiring-smoke/web-cfg"), "{ids:?}");
    assert!(graph.edges.iter().any(|e| e.id.starts_with("Deployment/wiring-smoke/web->Pod/wiring-smoke/")), "owner edges pass through hidden RS");
    assert!(graph.edges.iter().any(|e| e.source == "ConfigMap/wiring-smoke/web-cfg" && e.relation == wiring_lib::graph::Relation::EnvFrom));

    // Details for the deployment must render YAML + summary.
    let details = session.get_object("Deployment/wiring-smoke/web").unwrap();
    assert!(details.yaml.contains("kind: Deployment"));
    assert!(details.summary.iter().any(|(k, _)| k == "Replicas"));

    // Scale down and expect a delta removing a pod within the debounce window.
    kubectl(&context, &["-n", "wiring-smoke", "scale", "deployment/web", "--replicas=1"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv()).await.expect("delta before deadline").expect("emitter open");
        if let OutEvent::GraphDelta(d) = ev {
            if d.removed_nodes.iter().any(|id| id.starts_with("Pod/wiring-smoke/")) {
                break;
            }
        }
    }

    session.shutdown();
    kubectl(&context, &["delete", "namespace", "wiring-smoke", "--wait=false"]);
}
```

- [ ] **Step 3: Run it** (Docker Desktop's Kubernetes must be running: Docker Desktop → Settings → Kubernetes → Enable)

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored --nocapture 2>&1 | tail -15`
Expected: `test graph_snapshot_reflects_applied_fixture ... ok`. If the cluster is unavailable the test panics at `kubectl apply` — start the cluster and rerun; do not mark the task done on a failure.

- [ ] **Step 4: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Add headless smoke test against a live cluster"
```

---

### Task 15: Repo hygiene — README, rustfmt/clippy, spec touch-up

**Files:**
- Create: `README.md`, `src-tauri/rustfmt.toml`
- Modify: `docs/superpowers/specs/2026-09-17-wiring-mvp-design.md` (§9 kubeconfig bullet)

- [ ] **Step 1: README.md**

````markdown
# Wiring

A desktop Kubernetes IDE whose centerpiece is a live graph of how resources in a namespace are wired together — Ingress → Service → Deployment → Pod, plus ConfigMaps, Secrets, PVCs, ServiceAccounts and HPAs.

Built with Tauri 2, React and Rust (`kube-rs`). macOS and Windows.

## Development

```bash
pnpm install
pnpm tauri dev
```

Backend tests:

```bash
cd src-tauri
cargo test                                   # unit + IPC contract tests
WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored   # needs a running cluster + kubectl
```

## Docs

- Design spec: `docs/superpowers/specs/2026-09-17-wiring-mvp-design.md`
- Backend plan: `docs/superpowers/plans/2026-09-17-wiring-backend.md`
````

- [ ] **Step 2: rustfmt + clippy clean**

`src-tauri/rustfmt.toml`:
```toml
max_width = 140
```

Run: `cd /Users/skensel/WORKING/AI/wiring/src-tauri && cargo fmt && cargo clippy --all-targets 2>&1 | grep -E "^(warning|error)" | sort | uniq -c`
Expected: zero `error`; fix any `warning` that clippy reports in our own code (not in dependencies), then rerun `cargo test` — all green.

- [ ] **Step 3: Spec touch-up**

In the spec §9, change the `kubeconfig` bullet's "duplicate context names across files (later file wins, source recorded)" to "duplicate context names across files (first file wins, as kubectl does; source recorded)".

- [ ] **Step 4: Commit**

```bash
cd /Users/skensel/WORKING/AI/wiring && git add -A && git commit -m "Add README, rustfmt config; align spec with kubectl merge semantics"
```

---

## Done criteria for this plan

- `cargo test` green: store (5), graph model (4), status (5), relations (6), build (5), diff (2), kubeconfig (4), session (13), ipc_fixtures (7).
- `cargo test --test smoke -- --ignored` green against Docker Desktop.
- `pnpm tauri dev` opens the (still template) window without backend panics; `RUST_LOG=debug` shows plugin init.
- Next: frontend plan (`docs/superpowers/plans/<date>-wiring-frontend.md`) consumes the IPC fixtures in `src/shared/ipc/fixtures/` as its contract.
