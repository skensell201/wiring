# Problem Explanation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every yellow or red node carries a `problem` (reason, optional Kubernetes message, optional `cause` pointing at the neighbour to blame). Selecting it shows a **Problem** block at the top of Overview with the root cause and the clickable chain to it, and the chain is highlighted on the graph.

**Architecture:** `graph/status.rs` gains a pure `problem(obj, status, store)` next to `describe`, computing each object's own reason from its status fields (plus small status fixes so Services without ready endpoints, Ingresses with a missing backend and HPAs that cannot scale turn yellow). `graph/build.rs` stores it on each `Node`, aggregates member problems into PodGroups during the collapse, and after RS hiding and pod-group collapse runs `link_causes`, which points workloads at their worst `owns` child and Services at their worst `selects` target. Problems travel inside the existing `graph_snapshot` / `graph_delta`. The frontend follows `cause` with a pure `problemPath`, renders `ProblemBlock` in Overview (falling back to the selected object's newest Warning event) and tints the path in `toFlow`.

**Tech Stack:** Rust (serde, k8s-openapi 0.28 typed objects), React 19 + zustand 5, @xyflow/react, Tailwind tokens from `src/styles/theme.css`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-05-problem-explain-design.md`. **Branch:** `feat/problem-explain` (already checked out, based on `feat/workload-actions`).

**Conventions (all tasks):** TDD — write the failing test, run it and watch it fail, then implement. Rust tests: `cd src-tauri && rtk proxy cargo test`; frontend: `rtk proxy pnpm vitest run <path>` and `rtk proxy pnpm typecheck` (the `rtk proxy ` prefix returns raw output). Comments, tests and UI text in English. Every commit message ends with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
```

---

## File map

Backend (`src-tauri/`):
- Modify `src/graph/model.rs` — `Problem`, `Node.problem`.
- Modify `src/graph/status.rs` — `problem()`, per-kind reason helpers, `container_reason`, `is_completed`, `selected_pods`, `pod_ready`; Service / Ingress / HPA status tweaks.
- Modify `src/graph/relations.rs` — extract `ingress_backend_names` (shared with `status.rs`).
- Modify `src/graph/build.rs` — set `problem` on nodes, `group_problem` in `collapse_pod_groups`, `link_causes`.
- Modify `src/graph/diff.rs` (test helper only), `tests/ipc_fixtures.rs`, `tests/smoke.rs`, `tests/fixtures/smoke.yaml`.
- Create `tests/fixtures/problems.yaml`.

Frontend (`src/`):
- Modify `shared/ipc/types.ts` (`Problem`, `GraphNode.problem?`, `isProblem`), `shared/ipc/fixtures/graph.json`, `shared/ipc/fixtures.test.ts`.
- Create `features/graph/problemPath.ts` (+ test) — used by both the graph and the details panel.
- Create `features/details/ProblemBlock.tsx` (+ test); modify `features/details/OverviewTab.tsx`, `features/details/DetailsPanel.tsx`.
- Modify `features/graph/toFlow.ts`, `RelationEdge.tsx`, `ResourceNode.tsx` and their tests.

Docs: `docs/ipc-contract.md` (Problems section), `README.md` (Graph feature line).

---

### Task 1: `Problem` model and serialisation

**Files:**
- Modify: `src-tauri/src/graph/model.rs`
- Modify: `src-tauri/src/graph/build.rs:37-47,250-260` (struct literals), `src-tauri/src/graph/diff.rs:47-56` (test helper), `src-tauri/tests/ipc_fixtures.rs:28-38` (test helper)

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/graph/model.rs`, inside `mod tests`, add `problem: None,` to the two existing `Node { … }` literals (in `serializes_with_camel_case_and_lowercase_enums` and `test_node`), then add:

```rust
    #[test]
    fn problem_is_omitted_when_absent_and_camel_case_when_present() {
        let mut n = test_node("Pod/p/a");
        let json = serde_json::to_value(&n).unwrap();
        assert!(json.get("problem").is_none(), "a healthy node carries no problem key: {json}");

        n.problem = Some(Problem {
            reason: "ImagePullBackOff".into(),
            message: Some("container web: Back-off pulling image".into()),
            cause: None,
        });
        let json = serde_json::to_value(&n).unwrap();
        assert_eq!(
            json["problem"],
            serde_json::json!({ "reason": "ImagePullBackOff", "message": "container web: Back-off pulling image", "cause": null })
        );
        let back: Node = serde_json::from_value(json).unwrap();
        assert_eq!(back, n);
    }
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd src-tauri && rtk proxy cargo test --lib graph::model`
Expected: compile errors — `cannot find struct Problem`, `no field problem on type Node`.

- [ ] **Step 3: Implement**

In `src-tauri/src/graph/model.rs`, after `GroupInfo`, add:

```rust
/// Why a node is yellow or red. `cause` names the neighbour to blame (a workload's failing pod,
/// a Service's unready pods); the frontend follows it to the root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    pub reason: String,
    pub message: Option<String>,
    pub cause: Option<NodeId>,
}
```

and in `Node`, after `group`:

```rust
    /// Set only when `status` is Warn or Err.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<Problem>,
```

Add `problem: None,` after `group: …,` in every other `Node { … }` literal:
- `src-tauri/src/graph/build.rs` — the node built in `build()` (`group: None,`) and the PodGroup node in `collapse_pod_groups` (`group: Some(info),`);
- `src-tauri/src/graph/diff.rs` — the `node()` test helper;
- `src-tauri/tests/ipc_fixtures.rs` — the `node()` helper (after `group,`).

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && rtk proxy cargo test`
Expected: all pass (the new test included; JSON fixtures unchanged because `problem: None` is skipped).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/model.rs src-tauri/src/graph/build.rs src-tauri/src/graph/diff.rs src-tauri/tests/ipc_fixtures.rs
git commit -m "$(cat <<'EOF'
Add an optional problem to graph nodes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 2: Own reasons in `status.rs`

**Files:**
- Create: `src-tauri/tests/fixtures/problems.yaml`
- Modify: `src-tauri/src/graph/status.rs`, `src-tauri/src/graph/relations.rs:54-80`

- [ ] **Step 1: Add the fixture**

Create `src-tauri/tests/fixtures/problems.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata: { name: pull, namespace: p }
spec: { containers: [ { name: web, image: "nginx:nope" } ] }
status:
  phase: Pending
  containerStatuses:
    - { name: web, ready: false, restartCount: 0, image: "nginx:nope", imageID: "", state: { waiting: { reason: ImagePullBackOff, message: "Back-off pulling image \"nginx:nope\"" } } }
---
apiVersion: v1
kind: Pod
metadata: { name: crash, namespace: p, labels: { app: crash } }
spec: { containers: [ { name: api, image: api:1 } ] }
status:
  phase: Running
  conditions: [ { type: Ready, status: "False" } ]
  containerStatuses:
    - name: api
      ready: false
      restartCount: 5
      image: api:1
      imageID: ""
      state: { waiting: { reason: CrashLoopBackOff, message: "back-off 5m0s restarting failed container" } }
      lastState: { terminated: { exitCode: 1, reason: Error } }
---
apiVersion: v1
kind: Pod
metadata: { name: unsched, namespace: p }
spec: { containers: [ { name: c, image: nginx } ] }
status:
  phase: Pending
  conditions: [ { type: PodScheduled, status: "False", reason: Unschedulable, message: "0/3 nodes are available: 3 Insufficient cpu." } ]
---
apiVersion: v1
kind: Pod
metadata: { name: halfready, namespace: p }
spec: { containers: [ { name: a, image: nginx }, { name: b, image: nginx } ] }
status:
  phase: Running
  containerStatuses:
    - { name: a, ready: true, restartCount: 0, image: nginx, imageID: "", state: { running: {} } }
    - { name: b, ready: false, restartCount: 0, image: nginx, imageID: "", state: { running: {} } }
---
apiVersion: v1
kind: Pod
metadata: { name: chatty, namespace: p }
spec: { containers: [ { name: c, image: nginx } ] }
status:
  phase: Pending
  containerStatuses:
    - { name: c, ready: false, restartCount: 0, image: nginx, imageID: "", state: { waiting: { reason: CreateContainerConfigError, message: "LONG_MESSAGE_PLACEHOLDER" } } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: deadline, namespace: p }
spec:
  replicas: 2
  selector: { matchLabels: { app: deadline } }
  template: { metadata: { labels: { app: deadline } }, spec: { containers: [ { name: c, image: nginx } ] } }
status:
  replicas: 2
  readyReplicas: 0
  conditions: [ { type: Progressing, status: "False", reason: ProgressDeadlineExceeded, message: "ReplicaSet \"deadline-1\" has timed out progressing." } ]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: quota, namespace: p }
spec:
  replicas: 1
  selector: { matchLabels: { app: quota } }
  template: { metadata: { labels: { app: quota } }, spec: { containers: [ { name: c, image: nginx } ] } }
status:
  readyReplicas: 0
  conditions:
    - { type: Progressing, status: "True" }
    - { type: ReplicaFailure, status: "True", reason: FailedCreate, message: "pods \"quota-1\" is forbidden: exceeded quota: compute" }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: slow, namespace: p }
spec:
  replicas: 3
  selector: { matchLabels: { app: slow } }
  template: { metadata: { labels: { app: slow } }, spec: { containers: [ { name: c, image: nginx } ] } }
status: { replicas: 3, readyReplicas: 1, conditions: [ { type: Progressing, status: "True" } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: healthy, namespace: p }
spec:
  replicas: 1
  selector: { matchLabels: { app: healthy } }
  template: { metadata: { labels: { app: healthy } }, spec: { containers: [ { name: c, image: nginx } ] } }
status: { replicas: 1, readyReplicas: 1, conditions: [ { type: Progressing, status: "True" } ] }
---
apiVersion: batch/v1
kind: Job
metadata: { name: failed, namespace: p }
spec: { template: { spec: { containers: [ { name: c, image: busybox } ], restartPolicy: Never } } }
status: { failed: 4, conditions: [ { type: Failed, status: "True", reason: BackoffLimitExceeded, message: "Job has reached the specified backoff limit" } ] }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: paused, namespace: p }
spec: { schedule: "0 2 * * *", suspend: true, jobTemplate: { spec: { template: { spec: { containers: [ { name: c, image: busybox } ], restartPolicy: Never } } } } }
---
apiVersion: v1
kind: Service
metadata: { name: nopods, namespace: p }
spec: { selector: { app: nothing }, ports: [ { port: 80 } ] }
---
apiVersion: v1
kind: Service
metadata: { name: down, namespace: p }
spec: { selector: { app: crash }, ports: [ { port: 80 } ] }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: ing, namespace: p }
spec:
  rules:
    - host: shop.example.com
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: down, port: { number: 80 } } } }
          - { path: /api, pathType: Prefix, backend: { service: { name: missing, port: { number: 80 } } } }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: claim, namespace: p }
spec: { accessModes: [ ReadWriteOnce ], resources: { requests: { storage: 1Gi } } }
status: { phase: Pending }
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: nometrics, namespace: p }
spec: { minReplicas: 1, maxReplicas: 4, scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: healthy } }
status:
  currentReplicas: 1
  desiredReplicas: 1
  conditions:
    - { type: AbleToScale, status: "True" }
    - { type: ScalingActive, status: "False", reason: FailedGetResourceMetric, message: "unable to get metrics for resource cpu" }
```

Then replace `LONG_MESSAGE_PLACEHOLDER` with a 400-character message so the fixture tests trimming:

```bash
cd src-tauri && python3 - <<'EOF'
import pathlib
p = pathlib.Path("tests/fixtures/problems.yaml")
p.write_text(p.read_text().replace("LONG_MESSAGE_PLACEHOLDER", "x" * 400))
EOF
```

- [ ] **Step 2: Write the failing tests**

In `src-tauri/src/graph/status.rs`, inside `mod tests`, add:

```rust
    fn problem_of(store: &Store, kind: Kind, name: &str) -> Option<Problem> {
        let obj = store.find(kind, Some("p"), name).unwrap();
        let (status, _) = describe(obj, store);
        problem(obj, status, store)
    }

    fn own(reason: &str, message: Option<&str>) -> Option<Problem> {
        Some(Problem { reason: reason.into(), message: message.map(str::to_owned), cause: None })
    }

    #[test]
    fn pod_problems_name_the_container_and_kubelet_message() {
        let s = Store::from_fixture("problems").unwrap();
        assert_eq!(
            problem_of(&s, Kind::Pod, "pull"),
            own("ImagePullBackOff", Some("container web: Back-off pulling image \"nginx:nope\""))
        );
        assert_eq!(
            problem_of(&s, Kind::Pod, "crash"),
            own("CrashLoopBackOff", Some("container api: last exit code 1 (Error)"))
        );
        assert_eq!(
            problem_of(&s, Kind::Pod, "unsched"),
            own("Unschedulable", Some("0/3 nodes are available: 3 Insufficient cpu."))
        );
        assert_eq!(problem_of(&s, Kind::Pod, "halfready"), own("Not ready", Some("containers not ready: b")));
    }

    #[test]
    fn long_messages_are_trimmed_to_300_characters() {
        let s = Store::from_fixture("problems").unwrap();
        let p = problem_of(&s, Kind::Pod, "chatty").unwrap();
        assert_eq!(p.reason, "CreateContainerConfigError");
        let m = p.message.unwrap();
        assert_eq!(m.chars().count(), 300);
        assert!(m.starts_with("container c: xxx") && m.ends_with('…'), "{m}");
    }

    #[test]
    fn workload_problems_prefer_the_controller_condition() {
        let s = Store::from_fixture("problems").unwrap();
        assert_eq!(
            problem_of(&s, Kind::Deployment, "deadline"),
            own("ProgressDeadlineExceeded", Some("ReplicaSet \"deadline-1\" has timed out progressing."))
        );
        assert_eq!(
            problem_of(&s, Kind::Deployment, "quota"),
            own("FailedCreate", Some("pods \"quota-1\" is forbidden: exceeded quota: compute"))
        );
        assert_eq!(problem_of(&s, Kind::Deployment, "slow"), own("2 of 3 not ready", None));
        assert_eq!(problem_of(&s, Kind::Deployment, "healthy"), None);
        assert_eq!(
            problem_of(&s, Kind::Job, "failed"),
            own("BackoffLimitExceeded", Some("Job has reached the specified backoff limit"))
        );
        assert_eq!(problem_of(&s, Kind::CronJob, "paused"), own("Suspended", None));
    }

    #[test]
    fn network_storage_and_scaling_problems() {
        let s = Store::from_fixture("problems").unwrap();
        assert_eq!(problem_of(&s, Kind::Service, "nopods"), own("Selects no pods", None));
        assert_eq!(problem_of(&s, Kind::Service, "down"), own("No ready endpoints", None));
        assert_eq!(
            problem_of(&s, Kind::Ingress, "ing"),
            own("Backend not found", Some("service \"missing\" does not exist"))
        );
        assert_eq!(problem_of(&s, Kind::PersistentVolumeClaim, "claim"), own("Pending", None));
        assert_eq!(
            problem_of(&s, Kind::HorizontalPodAutoscaler, "nometrics"),
            own("FailedGetResourceMetric", Some("unable to get metrics for resource cpu"))
        );
    }

    #[test]
    fn services_ingresses_and_hpas_turn_yellow_when_they_cannot_work() {
        let s = Store::from_fixture("problems").unwrap();
        let status = |kind, name| describe(s.find(kind, Some("p"), name).unwrap(), &s).0;
        assert_eq!(status(Kind::Service, "down"), Status::Warn);
        assert_eq!(status(Kind::Ingress, "ing"), Status::Warn);
        assert_eq!(status(Kind::HorizontalPodAutoscaler, "nometrics"), Status::Warn);
        // The existing healthy cases stay green.
        let st = Store::from_fixture("statuses").unwrap();
        assert_eq!(describe(st.find(Kind::Service, Some("s"), "matched").unwrap(), &st).0, Status::Ok);
        assert_eq!(describe(st.find(Kind::Ingress, Some("s"), "multi").unwrap(), &st).0, Status::Ok);
    }
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `cd src-tauri && rtk proxy cargo test --lib graph::status`
Expected: compile error — `cannot find function problem` / `cannot find type Problem`.

- [ ] **Step 4: Extract the Ingress backend names**

In `src-tauri/src/graph/relations.rs`, add `use k8s_openapi::api::networking::v1::Ingress;` to the imports and replace the name collection in `ingress_edges` with a shared helper:

```rust
/// Every Service an Ingress routes to (default backend and rule paths), sorted and deduplicated.
pub fn ingress_backend_names(i: &Ingress) -> Vec<String> {
    let Some(spec) = i.spec.as_ref() else { return vec![] };
    let mut names: Vec<String> = vec![];
    if let Some(name) = spec
        .default_backend
        .as_ref()
        .and_then(|b| b.service.as_ref())
        .map(|s| s.name.clone())
    {
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
    names
}

/// Ingress -> Service via rules[].http.paths[].backend.service and defaultBackend.
pub fn ingress_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for ing in store.iter_kind(Kind::Ingress) {
        let Object::Ingress(i) = ing else { continue };
        for name in ingress_backend_names(i) {
            if let Some(svc) = store.find(Kind::Service, ing.namespace(), &name) {
                edges.push(Edge::new(id_of(ing), id_of(svc), Relation::Routes));
            }
        }
    }
    edges
}
```

- [ ] **Step 5: Implement `problem()` and the status tweaks**

In `src-tauri/src/graph/status.rs`:

Imports — replace the model/store `use` lines with:

```rust
use k8s_openapi::api::core::v1::ContainerStatus;

use super::model::{Problem, Status};
use super::relations::ingress_backend_names;
use crate::store::{Kind, Object, Store};
```

In `describe`, change the Ingress arm to `Object::Ingress(i) => ingress(i, store),`.

Replace the `is_completed` closure and the `reason` computation inside `pod()` with calls to two new helpers (keep the rest of `pod()` unchanged):

```rust
    let all_ready = !statuses.is_empty() && statuses.iter().all(|c| c.ready || is_completed(c));

    // A waiting/terminated reason is more informative than the phase.
    let reason = container_reason(&statuses).map(|(_, r)| r);
```

and add, above `pod()`:

```rust
/// A container that has legitimately finished (e.g. an init-like sidecar) is permanently
/// `ready: false` but should not count against the pod's readiness.
fn is_completed(c: &ContainerStatus) -> bool {
    c.state
        .as_ref()
        .and_then(|s| s.terminated.as_ref())
        .and_then(|t| t.reason.as_deref())
        == Some("Completed")
}

/// The first container with a waiting reason or a non-`Completed` terminated reason — the same
/// one the node badge shows.
fn container_reason(statuses: &[ContainerStatus]) -> Option<(&ContainerStatus, String)> {
    statuses.iter().find_map(|c| {
        let state = c.state.as_ref()?;
        let reason = state.waiting.as_ref().and_then(|w| w.reason.clone()).or_else(|| {
            state
                .terminated
                .as_ref()
                .and_then(|t| t.reason.clone())
                .filter(|r| r != "Completed")
        })?;
        Some((c, reason))
    })
}
```

Replace `service()`'s status computation with readiness-aware matching:

```rust
/// A pod without a `Ready` condition counts as ready, so hand-written fixtures stay healthy.
fn pod_ready(p: &Pod) -> bool {
    p.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .is_none_or(|cs| !cs.iter().any(|c| c.type_ == "Ready" && c.status == "False"))
}

/// Pods a Service's selector matches and how many of them are ready; `None` without a selector
/// (headless/ExternalName services are not orphans).
fn selected_pods(s: &Service, store: &Store) -> Option<(usize, usize)> {
    let sel = s.spec.as_ref()?.selector.as_ref()?;
    let ns = s.metadata.namespace.as_deref();
    let (mut matched, mut ready) = (0, 0);
    for p in store.iter_kind(Kind::Pod).filter(|p| p.namespace() == ns) {
        if !selector_matches(sel, p.meta().labels.as_ref()) {
            continue;
        }
        matched += 1;
        if matches!(p, Object::Pod(pod) if pod_ready(pod)) {
            ready += 1;
        }
    }
    Some((matched, ready))
}
```

and in `service()` replace the `let status = match spec.and_then(|s| s.selector.as_ref()) { … };` block with:

```rust
    let status = match selected_pods(s, store) {
        Some((_, ready)) if ready == 0 => Status::Warn,
        _ => Status::Ok,
    };
```

(`ready == 0` covers both "selects no pods" and "none of them ready".)

Change `ingress` to take the store and warn on a missing backend:

```rust
fn ingress(i: &Ingress, store: &Store) -> (Status, Badges) {
    // … hosts / badge computation unchanged …
    let missing = !missing_backends(i, store).is_empty();
    (if missing { Status::Warn } else { Status::Ok }, badge.into_iter().collect())
}

fn missing_backends(i: &Ingress, store: &Store) -> Vec<String> {
    ingress_backend_names(i)
        .into_iter()
        .filter(|name| store.find(Kind::Service, i.metadata.namespace.as_deref(), name).is_none())
        .collect()
}
```

Change `hpa()`'s `limited` to also cover an HPA that cannot scale at all:

```rust
    let conds = st.and_then(|s| s.conditions.as_deref()).unwrap_or_default();
    let has = |ty: &str, status: &str| conds.iter().any(|c| c.type_ == ty && c.status == status);
    let limited = has("ScalingLimited", "True") || has("ScalingActive", "False") || has("AbleToScale", "False");
```

Then add the problem computation after `hpa()`:

```rust
const MESSAGE_LIMIT: usize = 300;

/// A problem with no cause yet (`graph::build` links causes); the message is trimmed.
fn own(reason: impl Into<String>, message: Option<String>) -> Problem {
    let message = message.map(|m| {
        if m.chars().count() <= MESSAGE_LIMIT {
            m
        } else {
            let mut t: String = m.chars().take(MESSAGE_LIMIT - 1).collect();
            t.push('…');
            t
        }
    });
    Problem { reason: reason.into(), message, cause: None }
}

/// Why `obj` is yellow or red, from its own status fields; `None` for healthy objects.
pub fn problem(obj: &Object, status: Status, store: &Store) -> Option<Problem> {
    if status < Status::Warn {
        return None;
    }
    Some(match obj {
        Object::Pod(p) => pod_problem(p),
        Object::Deployment(d) => deployment_problem(d),
        Object::StatefulSet(s) => {
            let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            not_ready(s.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0), desired)
        }
        Object::DaemonSet(d) => {
            let st = d.status.as_ref();
            not_ready(st.map(|s| s.number_ready).unwrap_or(0), st.map(|s| s.desired_number_scheduled).unwrap_or(0))
        }
        Object::ReplicaSet(r) => {
            let desired = r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            not_ready(r.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0), desired)
        }
        Object::Job(j) => {
            let failed = j
                .status
                .as_ref()
                .and_then(|s| s.conditions.as_deref())
                .unwrap_or_default()
                .iter()
                .find(|c| c.type_ == "Failed" && c.status == "True");
            match failed {
                Some(c) => own(c.reason.clone().unwrap_or_else(|| "Failed".into()), c.message.clone()),
                None => own("Failed", None),
            }
        }
        Object::CronJob(_) => own("Suspended", None),
        Object::Service(s) => match selected_pods(s, store) {
            Some((0, _)) => own("Selects no pods", None),
            _ => own("No ready endpoints", None),
        },
        Object::Ingress(i) => {
            let missing = missing_backends(i, store);
            let message = match missing.as_slice() {
                [one] => format!("service \"{one}\" does not exist"),
                many => format!(
                    "services {} do not exist",
                    many.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(", ")
                ),
            };
            own("Backend not found", Some(message))
        }
        Object::PersistentVolumeClaim(_) => own("Pending", None),
        Object::HorizontalPodAutoscaler(h) => {
            let conds = h.status.as_ref().and_then(|s| s.conditions.as_deref()).unwrap_or_default();
            let pick = [("ScalingActive", "False"), ("AbleToScale", "False"), ("ScalingLimited", "True")]
                .iter()
                .find_map(|(ty, st)| conds.iter().find(|c| c.type_ == *ty && c.status == *st));
            match pick {
                Some(c) => own(c.reason.clone().unwrap_or_else(|| c.type_.clone()), c.message.clone()),
                None => own("ScalingLimited", None),
            }
        }
        _ => return None,
    })
}

/// `N of M not ready`, or `Rolling out` for a workload that is yellow only because a rollout runs.
fn not_ready(ready: i32, desired: i32) -> Problem {
    if ready < desired {
        own(format!("{} of {desired} not ready", desired - ready), None)
    } else {
        own("Rolling out", None)
    }
}

fn deployment_problem(d: &Deployment) -> Problem {
    let conds = d.status.as_ref().and_then(|s| s.conditions.as_deref()).unwrap_or_default();
    let failing = conds
        .iter()
        .find(|c| c.type_ == "Progressing" && c.status == "False")
        .or_else(|| conds.iter().find(|c| c.type_ == "ReplicaFailure" && c.status == "True"));
    if let Some(c) = failing {
        return own(c.reason.clone().unwrap_or_else(|| c.type_.clone()), c.message.clone());
    }
    let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    not_ready(d.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0), desired)
}

fn pod_problem(p: &Pod) -> Problem {
    let st = p.status.as_ref();
    let statuses = st.and_then(|s| s.container_statuses.as_deref()).unwrap_or_default();
    let terminating = p.metadata.deletion_timestamp.is_some();
    if let Some((c, reason)) = container_reason(statuses) {
        // Same precedence as the badge: an err reason wins over Terminating.
        if !terminating || POD_ERR_REASONS.contains(&reason.as_str()) {
            let message = container_message(c, &reason);
            return own(reason, message);
        }
    }
    if terminating {
        return own("Terminating", None);
    }
    let conds = st.and_then(|s| s.conditions.as_deref()).unwrap_or_default();
    if let Some(c) = conds.iter().find(|c| c.type_ == "PodScheduled" && c.status == "False") {
        return own(c.reason.clone().unwrap_or_else(|| "Unschedulable".into()), c.message.clone());
    }
    let phase = st.and_then(|s| s.phase.clone()).unwrap_or_else(|| "Unknown".into());
    if phase != "Running" {
        return own(phase, st.and_then(|s| s.message.clone()));
    }
    let names: Vec<&str> = statuses
        .iter()
        .filter(|c| !c.ready && !is_completed(c))
        .map(|c| c.name.as_str())
        .collect();
    own("Not ready", (!names.is_empty()).then(|| format!("containers not ready: {}", names.join(", "))))
}

/// `container <name>: <text>` — for CrashLoopBackOff the last run's exit code, for a terminated
/// container its exit code and message, otherwise the waiting message.
fn container_message(c: &ContainerStatus, reason: &str) -> Option<String> {
    let state = c.state.as_ref();
    let waiting = state.and_then(|s| s.waiting.as_ref()).and_then(|w| w.message.clone());
    let terminated = state
        .and_then(|s| s.terminated.as_ref())
        .filter(|t| t.reason.as_deref() == Some(reason));
    let text = if reason == "CrashLoopBackOff" {
        c.last_state
            .as_ref()
            .and_then(|s| s.terminated.as_ref())
            .map(|t| format!("last exit code {} ({})", t.exit_code, t.reason.as_deref().unwrap_or("Error")))
            .or(waiting)
    } else if let Some(t) = terminated {
        Some(match &t.message {
            Some(m) => format!("exit code {}: {m}", t.exit_code),
            None => format!("exit code {}", t.exit_code),
        })
    } else {
        waiting
    }?;
    Some(format!("container {}: {text}", c.name))
}
```

- [ ] **Step 6: Run the tests**

Run: `cd src-tauri && rtk proxy cargo test`
Expected: the five new tests pass and the existing status/relations/build tests still pass. If an existing assertion now sees `Warn` for `Ingress/r/web-ing` (the `relations` fixture routes to a non-existent `does-not-exist` service), that is the intended new behaviour: update that assertion to `Status::Warn` and say so in the commit message.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/graph/status.rs src-tauri/src/graph/relations.rs src-tauri/tests/fixtures/problems.yaml
git commit -m "$(cat <<'EOF'
Explain why each yellow or red object is unhealthy

Services without ready endpoints, Ingresses with a missing backend and
HPAs that cannot scale now turn yellow too.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 3: Problems on graph nodes, PodGroup aggregation and cause links

**Files:**
- Modify: `src-tauri/src/graph/build.rs`

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/graph/build.rs`, inside `mod tests`, add (`use crate::graph::model::Problem;` at the top of the test module):

```rust
    fn problem<'a>(g: &'a Graph, id: &str) -> Option<&'a Problem> {
        g.node(id).and_then(|n| n.problem.as_ref())
    }

    #[test]
    fn a_workload_points_at_its_failing_pod_group() {
        let s = Store::from_fixture("podgroup").unwrap();
        let g = build(&s, &BuildOptions::default());
        assert_eq!(
            problem(&g, "Deployment/g/api"),
            Some(&Problem {
                reason: "1 of 7 not ready".into(),
                message: None,
                cause: Some("PodGroup/g/Deployment/api".into()),
            })
        );
        assert_eq!(
            problem(&g, "PodGroup/g/Deployment/api"),
            Some(&Problem {
                reason: "1 of 7 pods: CrashLoopBackOff".into(),
                message: Some("api-new-7".into()),
                cause: None,
            })
        );
        // Six ready pods behind it: the Service is fine.
        assert_eq!(problem(&g, "Service/g/api"), None);
    }

    #[test]
    fn an_expanded_group_lets_the_cause_name_the_pod() {
        let s = Store::from_fixture("podgroup").unwrap();
        let opts = BuildOptions {
            expanded_groups: ["PodGroup/g/Deployment/api".to_string()].into_iter().collect(),
            ..Default::default()
        };
        let g = build(&s, &opts);
        assert_eq!(
            problem(&g, "Deployment/g/api").and_then(|p| p.cause.as_deref()),
            Some("Pod/g/api-new-7")
        );
        assert_eq!(problem(&g, "Pod/g/api-new-7").map(|p| p.reason.as_str()), Some("CrashLoopBackOff"));
    }

    #[test]
    fn healthy_graphs_carry_no_problems() {
        let s = Store::from_fixture("deployment-basic").unwrap();
        let g = build(&s, &BuildOptions::default());
        assert!(g.nodes.iter().all(|n| n.problem.is_none()), "{:#?}", g.nodes);
    }

    #[test]
    fn equal_culprits_resolve_to_the_smallest_id() {
        let s = Store::from_yaml_docs(
            r#"
apiVersion: apps/v1
kind: Deployment
metadata: { name: tie, namespace: t, uid: dep-tie }
spec:
  replicas: 2
  selector: { matchLabels: { app: tie } }
  template: { metadata: { labels: { app: tie } }, spec: { containers: [ { name: c, image: x } ] } }
status: { replicas: 2, readyReplicas: 0 }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata: { name: tie-1, namespace: t, uid: rs-tie, ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: tie, uid: dep-tie, controller: true } ] }
spec:
  replicas: 2
  selector: { matchLabels: { app: tie } }
  template: { metadata: { labels: { app: tie } }, spec: { containers: [ { name: c, image: x } ] } }
status: { replicas: 2, readyReplicas: 0 }
---
apiVersion: v1
kind: Pod
metadata: { name: tie-1-b, namespace: t, labels: { app: tie }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: tie-1, uid: rs-tie, controller: true } ] }
spec: { containers: [ { name: c, image: x } ] }
status: { phase: Pending, containerStatuses: [ { name: c, ready: false, restartCount: 0, image: x, imageID: "", state: { waiting: { reason: ErrImagePull } } } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: tie-1-a, namespace: t, labels: { app: tie }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: tie-1, uid: rs-tie, controller: true } ] }
spec: { containers: [ { name: c, image: x } ] }
status: { phase: Pending, containerStatuses: [ { name: c, ready: false, restartCount: 0, image: x, imageID: "", state: { waiting: { reason: ErrImagePull } } } ] }
"#,
        )
        .unwrap();
        let g = build(&s, &BuildOptions::default());
        assert_eq!(
            problem(&g, "Deployment/t/tie").and_then(|p| p.cause.as_deref()),
            Some("Pod/t/tie-1-a")
        );
    }

    #[test]
    fn group_reason_is_the_most_common_one_among_the_worst_pods() {
        let pod = |name: &str, status: Status, reason: &str, message: Option<&str>| Node {
            id: format!("Pod/g/{name}"),
            kind: Kind::Pod,
            namespace: Some("g".into()),
            name: name.into(),
            status,
            badges: vec![],
            group: None,
            problem: Some(Problem { reason: reason.into(), message: message.map(str::to_owned), cause: None }),
        };
        let members = vec![
            pod("c", Status::Err, "OOMKilled", None),
            pod("b", Status::Err, "CrashLoopBackOff", Some("container api: last exit code 1 (Error)")),
            pod("a", Status::Err, "CrashLoopBackOff", None),
            pod("d", Status::Warn, "Not ready", None),
        ];
        assert_eq!(
            group_problem(&members, Status::Err, 6),
            Some(Problem {
                reason: "2 of 6 pods: CrashLoopBackOff".into(),
                message: Some("a".into()),
                cause: None,
            })
        );
        // Ties go to the alphabetically first reason.
        let tie = vec![pod("x", Status::Err, "OOMKilled", None), pod("y", Status::Err, "Error", Some("container c: exit code 2"))];
        assert_eq!(
            group_problem(&tie, Status::Err, 2).map(|p| (p.reason, p.message)),
            Some(("1 of 2 pods: Error".into(), Some("y: container c: exit code 2".into())))
        );
        assert_eq!(group_problem(&members, Status::Ok, 6), None);
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd src-tauri && rtk proxy cargo test --lib graph::build`
Expected: compile error (`group_problem` not found); after a stub, the problem assertions fail with `None`.

- [ ] **Step 3: Implement**

In `src-tauri/src/graph/build.rs`:

Imports:

```rust
use super::model::{node_id, Edge, Graph, GroupInfo, Node, NodeId, Problem, Relation, Status};
use super::relations::all_edges;
use super::status::{describe, problem as own_problem};
```

In `build()`, compute and store the node's own problem:

```rust
        let (status, badges) = describe(obj, store);
        let problem = own_problem(obj, status, store);
        let id = node_id(obj.kind(), obj.namespace(), obj.name());
        nodes.insert(
            id.clone(),
            Node {
                id,
                kind: obj.kind(),
                namespace: obj.namespace().map(str::to_owned),
                name: obj.name().to_owned(),
                status,
                badges,
                group: None,
                problem,
            },
        );
```

and run the link pass right after `collapse_pod_groups(&mut nodes, &mut edges, opts);`:

```rust
    // On the final nodes and edges, so every cause names a visible node.
    link_causes(&mut nodes, &edges);
```

In `collapse_pod_groups`, keep the removed member nodes and give the group a problem. Change the member loop and the group node:

```rust
        let mut worst = Status::Unknown;
        let mut collapsed: Vec<Node> = vec![];
        for pod_id in &pods {
            // … existing comment …
            let Some(pod) = nodes.remove(pod_id) else { continue };
            info.count += 1;
            match pod.status {
                Status::Ok => info.ok += 1,
                Status::Warn => info.warn += 1,
                Status::Err => info.err += 1,
                Status::Unknown => {}
            }
            worst = worst.max(pod.status);
            remap.insert(pod_id.clone(), group_id.clone());
            collapsed.push(pod);
        }
        if info.count == 0 {
            continue;
        }
        let badges = group_badges(&info);
        let problem = group_problem(&collapsed, worst, info.count);
        nodes.insert(
            group_id.clone(),
            Node {
                id: group_id.clone(),
                kind: Kind::PodGroup,
                namespace: owner_ns,
                name: owner_name,
                status: worst,
                badges,
                group: Some(info),
                problem,
            },
        );
```

Add the two helpers after `collapse_pod_groups`:

```rust
/// `K of N pods: <reason>` for the most common reason among the worst-status members (ties go to
/// the alphabetically first reason), with the message of the first such member by name.
fn group_problem(members: &[Node], worst: Status, count: usize) -> Option<Problem> {
    if worst < Status::Warn {
        return None;
    }
    let mut by_reason: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for m in members.iter().filter(|m| m.status == worst) {
        if let Some(p) = &m.problem {
            by_reason.entry(p.reason.as_str()).or_default().push(m);
        }
    }
    let (reason, mut pods) = by_reason
        .into_iter()
        .fold(None, |best: Option<(&str, Vec<&Node>)>, (r, v)| match &best {
            Some((_, b)) if b.len() >= v.len() => best,
            _ => Some((r, v)),
        })?;
    pods.sort_by(|a, b| a.name.cmp(&b.name));
    let first = pods[0];
    let message = match first.problem.as_ref().and_then(|p| p.message.as_deref()) {
        Some(m) => format!("{}: {m}", first.name),
        None => first.name.clone(),
    };
    Some(Problem {
        reason: format!("{} of {count} pods: {reason}", pods.len()),
        message: Some(message),
        cause: None,
    })
}

/// Point each delegating problem at the neighbour to blame: the worst-status (Warn/Err) target of
/// a workload's `owns` edges or a Service's `selects` edges; ties go to the smallest id.
fn link_causes(nodes: &mut HashMap<NodeId, Node>, edges: &[Edge]) {
    let links: Vec<(NodeId, NodeId)> = nodes
        .values()
        .filter(|n| n.problem.is_some())
        .filter_map(|n| {
            let relation = match n.kind {
                Kind::Deployment | Kind::StatefulSet | Kind::DaemonSet | Kind::ReplicaSet | Kind::Job | Kind::CronJob => {
                    Relation::Owns
                }
                Kind::Service => Relation::Selects,
                _ => return None,
            };
            edges
                .iter()
                .filter(|e| e.source == n.id && e.relation == relation)
                .filter_map(|e| nodes.get(&e.target))
                .filter(|t| t.status >= Status::Warn)
                .max_by(|a, b| a.status.cmp(&b.status).then_with(|| b.id.cmp(&a.id)))
                .map(|t| (n.id.clone(), t.id.clone()))
        })
        .collect();
    for (id, cause) in links {
        if let Some(p) = nodes.get_mut(&id).and_then(|n| n.problem.as_mut()) {
            p.cause = Some(cause);
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && rtk proxy cargo test && rtk proxy cargo clippy --all-targets -- -D warnings`
Expected: all pass, clippy clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/build.rs
git commit -m "$(cat <<'EOF'
Link each problem to the neighbour to blame and sum up pod groups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 4: IPC contract and fixture

**Files:**
- Modify: `src/shared/ipc/fixtures/graph.json`, `src-tauri/tests/ipc_fixtures.rs:66-100`, `docs/ipc-contract.md`

- [ ] **Step 1: Write the failing test**

In `src-tauri/tests/ipc_fixtures.rs`, add `Problem` to the `wiring_lib::graph::{…}` import, and in `fn graph()` give the PodGroup node a problem — replace the second `node(…)` call with:

```rust
            Node {
                problem: Some(Problem {
                    reason: "1 of 7 pods: CrashLoopBackOff".into(),
                    message: Some("web-7f9c-x2k: container web: last exit code 1 (Error)".into()),
                    cause: None,
                }),
                ..node(
                    "PodGroup/payments/Deployment/web",
                    Kind::PodGroup,
                    "web",
                    Status::Err,
                    &["×7", "6 ok · 1 err"],
                    Some(GroupInfo {
                        count: 7,
                        ok: 6,
                        warn: 0,
                        err: 1,
                    }),
                )
            },
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd src-tauri && rtk proxy cargo test --test ipc_fixtures graph`
Expected: FAIL — `fixture graph.json drifted from the Rust type`.

- [ ] **Step 3: Update the fixture and the contract**

In `src/shared/ipc/fixtures/graph.json`, add to the PodGroup node (after `"group": {…}`):

```json
      "problem": {
        "reason": "1 of 7 pods: CrashLoopBackOff",
        "message": "web-7f9c-x2k: container web: last exit code 1 (Error)",
        "cause": null
      }
```

In `docs/ipc-contract.md`, add a section after `## Node ids`:

```markdown
## Problems

A node whose `status` is `warn` or `err` may carry `problem: { reason, message, cause }`; healthy nodes have no `problem` key at all.
- `reason` is short (`ImagePullBackOff`, `2 of 3 not ready`, `No ready endpoints`, `Backend not found`, `1 of 7 pods: CrashLoopBackOff`). `message` is the Kubernetes text behind it (kubelet, scheduler or controller), at most 300 characters, or `null`.
- `cause` is the id of a node in the same graph to blame next (a workload's worst-status owned child, a Service's worst-status selected pod or pod group), or `null` at the root. It is resolved after ReplicaSet hiding and pod-group collapse, so it always names a visible node. Follow it to the root, stopping at a missing node, a repeat or 8 steps.
- A PodGroup's problem summarises its members: `K of N pods: <reason>` with the message of the first such pod by name, prefixed with the pod name.
- Problems change with the objects, so they arrive through the usual `graph_snapshot` / `graph_delta` (`updatedNodes`).
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && rtk proxy cargo test --test ipc_fixtures` and `rtk proxy pnpm vitest run src/shared/ipc`
Expected: Rust passes; the TS fixture test still passes (the guard ignores unknown keys until Task 6).

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc/fixtures/graph.json src-tauri/tests/ipc_fixtures.rs docs/ipc-contract.md
git commit -m "$(cat <<'EOF'
Document node problems in the IPC contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 5: Smoke test — a broken image explains itself

**Files:**
- Modify: `src-tauri/tests/fixtures/smoke.yaml`, `src-tauri/tests/smoke.rs`

- [ ] **Step 1: Add a broken Deployment to the fixture**

Append to `src-tauri/tests/fixtures/smoke.yaml`:

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: broken, namespace: wiring-smoke }
spec:
  replicas: 1
  selector: { matchLabels: { app: broken } }
  template:
    metadata: { labels: { app: broken } }
    spec: { containers: [ { name: broken, image: "registry.k8s.io/pause:wiring-does-not-exist" } ] }
```

(Its pod is `broken-…`, so `web_pod_count` and `pod_names`, which only count `web-` pods, are unaffected; nothing waits for its rollout.)

- [ ] **Step 2: Assert the cause chain**

In `src-tauri/tests/smoke.rs`, add `Problem` to the `wiring_lib::graph::{…}` import and a helper after `has_node`:

```rust
/// The problem at the end of `id`'s cause chain (at most 8 hops), as the frontend resolves it.
fn root_problem<'a>(g: &'a Graph, id: &str) -> Option<&'a Problem> {
    let mut problem = g.node(id)?.problem.as_ref()?;
    for _ in 0..8 {
        let Some(next) = problem.cause.as_deref() else { break };
        problem = g.node(next)?.problem.as_ref()?;
    }
    Some(problem)
}
```

In `graph_snapshot_reflects_applied_fixture`, right after the `fixture never fully appeared` assertion, add:

```rust
    // A pod that cannot pull its image explains its Deployment.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let ok = graph_until(&mut rx, &mut graph, deadline, |g| {
        root_problem(g, "Deployment/wiring-smoke/broken")
            .is_some_and(|p| p.reason == "ImagePullBackOff" || p.reason == "ErrImagePull")
    })
    .await;
    assert!(ok, "the broken image never explained its Deployment; last graph: {graph:#?}");
```

- [ ] **Step 3: Run it**

Run: `cd src-tauri && WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored --nocapture`
Expected: PASS. Only the local `docker-desktop` context; the test only touches its own `wiring-smoke` namespace.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/fixtures/smoke.yaml src-tauri/tests/smoke.rs
git commit -m "$(cat <<'EOF'
Smoke-test that a broken image explains its Deployment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 6: Frontend types and guard

**Files:**
- Modify: `src/shared/ipc/types.ts`, `src/shared/ipc/fixtures.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/shared/ipc/fixtures.test.ts`, add `isGraphNode` to the import from `./types`, and inside the `describe`:

```ts
  it("graph nodes carry an optional problem", () => {
    const group = graph.nodes[1];
    expect(group.problem?.reason).toBe("1 of 7 pods: CrashLoopBackOff");
    expect(isGraphNode(group)).toBe(true);
    expect(isGraphNode(graph.nodes[0])).toBe(true); // no problem key at all
    expect(isGraphNode({ ...group, problem: { reason: 3, message: null, cause: null } })).toBe(false);
    expect(isGraphNode({ ...group, problem: { reason: "x", message: null } })).toBe(false);
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `rtk proxy pnpm vitest run src/shared/ipc`
Expected: FAIL — `problem` does not exist on the node type (typecheck) / the malformed problem is accepted.

- [ ] **Step 3: Implement**

In `src/shared/ipc/types.ts`, after `GroupInfo`:

```ts
/** Why a node is yellow or red; `cause` names the neighbour to blame (see docs/ipc-contract.md#problems). */
export interface Problem { reason: string; message: string | null; cause: NodeId | null }
```

add to `GraphNode`, after `group`:

```ts
  /** Present only on warn/err nodes. */
  problem?: Problem;
```

and replace `isGraphNode` with:

```ts
function isProblem(v: unknown): v is Problem {
  return isObj(v) && isStr(v.reason) && isStrOrNull(v.message) && isStrOrNull(v.cause);
}
export function isGraphNode(v: unknown): v is GraphNode {
  return isObj(v) && isStr(v.id) && oneOf(KINDS, v.kind) && isStrOrNull(v.namespace) && isStr(v.name)
    && oneOf(STATUSES, v.status) && arrayOf(v.badges, isStr) && (v.group === null || (isObj(v.group) && typeof v.group.count === "number"))
    && (v.problem === undefined || isProblem(v.problem));
}
```

(`isStrOrNull` must reject `undefined` for the second malformed case — it does if it is `v === null || typeof v === "string"`; check its definition and keep it that way.)

- [ ] **Step 4: Run the tests**

Run: `rtk proxy pnpm vitest run src/shared/ipc && rtk proxy pnpm typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc/types.ts src/shared/ipc/fixtures.test.ts
git commit -m "$(cat <<'EOF'
Mirror node problems in the frontend IPC types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 7: `problemPath` helper

**Files:**
- Create: `src/features/graph/problemPath.ts`, `src/features/graph/problemPath.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/features/graph/problemPath.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GraphNode, NodeId, Problem } from "../../shared/ipc/types";
import { MAX_PATH, problemPath } from "./problemPath";

const n = (id: NodeId, problem?: Problem): GraphNode => ({ id, kind: "Pod", namespace: "p", name: id, status: problem ? "err" : "ok", badges: [], group: null, ...(problem ? { problem } : {}) });
const p = (cause: NodeId | null): Problem => ({ reason: "r", message: null, cause });
const map = (...nodes: GraphNode[]) => new Map(nodes.map((x) => [x.id, x]));

describe("problemPath", () => {
  it("follows cause to the root", () => {
    expect(problemPath("a", map(n("a", p("b")), n("b", p("c")), n("c", p(null))))).toEqual(["a", "b", "c"]);
  });
  it("is empty for a node without a problem, and stops at a missing or healthy node", () => {
    expect(problemPath("a", map(n("a")))).toEqual([]);
    expect(problemPath("a", map(n("a", p("gone"))))).toEqual(["a"]);
    expect(problemPath("a", map(n("a", p("b")), n("b")))).toEqual(["a"]);
  });
  it("stops at a repeat", () => {
    expect(problemPath("a", map(n("a", p("b")), n("b", p("a"))))).toEqual(["a", "b"]);
  });
  it("caps the chain", () => {
    const chain = Array.from({ length: 12 }, (_, i) => n(`n${i}`, p(i < 11 ? `n${i + 1}` : null)));
    expect(problemPath("n0", map(...chain))).toHaveLength(MAX_PATH);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `rtk proxy pnpm vitest run src/features/graph/problemPath.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/features/graph/problemPath.ts`:

```ts
import type { GraphNode, NodeId } from "../../shared/ipc/types";

/** The longest cause chain followed; the backend only links downwards, this guards the UI anyway. */
export const MAX_PATH = 8;

/** `id` and the nodes its problem's `cause` chain leads to, ending at the root cause.
 *  Empty when `id` has no problem; stops at a missing node, a node without a problem or a repeat. */
export function problemPath(id: NodeId, nodes: Map<NodeId, GraphNode>): NodeId[] {
  const path: NodeId[] = [];
  let current: NodeId | null = id;
  while (current !== null && path.length < MAX_PATH && !path.includes(current)) {
    const node = nodes.get(current);
    if (!node?.problem) break;
    path.push(current);
    current = node.problem.cause;
  }
  return path;
}
```

- [ ] **Step 4: Run the test**

Run: `rtk proxy pnpm vitest run src/features/graph/problemPath.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/graph/problemPath.ts src/features/graph/problemPath.test.ts
git commit -m "$(cat <<'EOF'
Follow a node's problem to its root cause

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 8: Problem block in Overview

**Files:**
- Create: `src/features/details/ProblemBlock.tsx`, `src/features/details/ProblemBlock.test.tsx`
- Modify: `src/features/details/OverviewTab.tsx`, `src/features/details/DetailsPanel.tsx:168`

- [ ] **Step 1: Write the failing test**

Create `src/features/details/ProblemBlock.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore, viewEditor } from "../../app/store";
import type { GraphNode, K8sEvent } from "../../shared/ipc/types";
import { ProblemBlock } from "./ProblemBlock";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const dep: GraphNode = {
  id: "Deployment/p/bad", kind: "Deployment", namespace: "p", name: "bad", status: "warn", badges: ["0/1"], group: null,
  problem: { reason: "1 of 1 not ready", message: null, cause: "Pod/p/bad-1" },
};
const pod: GraphNode = {
  id: "Pod/p/bad-1", kind: "Pod", namespace: "p", name: "bad-1", status: "err", badges: ["ImagePullBackOff"], group: null,
  problem: { reason: "ImagePullBackOff", message: "container web: Back-off pulling image \"nginx:nope\"", cause: null },
};
const pvc: GraphNode = {
  id: "PersistentVolumeClaim/p/data", kind: "PersistentVolumeClaim", namespace: "p", name: "data", status: "warn", badges: [], group: null,
  problem: { reason: "Pending", message: null, cause: null },
};
const ok: GraphNode = { id: "Service/p/web", kind: "Service", namespace: "p", name: "web", status: "ok", badges: [], group: null };
const warning: K8sEvent = { name: "e1", type: "Warning", reason: "ProvisioningFailed", message: "storageclass \"fast\" not found", count: 2, firstTimestamp: null, lastTimestamp: null };
const normal: K8sEvent = { ...warning, name: "e0", type: "Normal", reason: "Provisioning", message: "waiting" };

function showing(id: string, events: K8sEvent[] = []) {
  useAppStore.setState({
    ...applySnapshot(initialState(), { nodes: [dep, pod, pvc, ok], edges: [] }),
    selectedId: id,
    details: { nodeId: id, loading: false, editor: viewEditor(""), data: { yaml: "", summary: [], related: [] }, events },
  });
}

beforeEach(() => showing(dep.id));

describe("ProblemBlock", () => {
  it("shows the root cause and a clickable path", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ select });
    render(<ProblemBlock nodeId={dep.id} />);
    expect(screen.getByText("ImagePullBackOff")).toBeInTheDocument();
    expect(screen.getByText("container web: Back-off pulling image \"nginx:nope\"")).toBeInTheDocument();
    const path = screen.getByRole("list", { name: "Path" });
    fireEvent.click(screen.getByRole("button", { name: /Pod bad-1/ }));
    expect(select).toHaveBeenCalledWith("Pod/p/bad-1");
    expect(path).toHaveTextContent(/Deployment bad.*Pod bad-1/);
  });

  it("uses the error colour when the root is red, the warning colour otherwise", () => {
    const { unmount } = render(<ProblemBlock nodeId={dep.id} />);
    expect(screen.getByRole("status", { name: "Problem" }).className).toContain("status-err");
    unmount();
    showing(pvc.id);
    render(<ProblemBlock nodeId={pvc.id} />);
    expect(screen.getByRole("status", { name: "Problem" }).className).toContain("status-warn");
  });

  it("falls back to the newest Warning event when the root has no message", () => {
    showing(pvc.id, [normal, warning]);
    render(<ProblemBlock nodeId={pvc.id} />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("ProvisioningFailed — storageclass \"fast\" not found")).toBeInTheDocument();
    expect(screen.getByText("from Events")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Path" })).not.toBeInTheDocument();
  });

  it("renders nothing for a healthy node", () => {
    showing(ok.id, [warning]);
    const { container } = render(<ProblemBlock nodeId={ok.id} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `rtk proxy pnpm vitest run src/features/details/ProblemBlock.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the block**

Create `src/features/details/ProblemBlock.tsx`:

```tsx
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { K8sEvent, NodeId } from "../../shared/ipc/types";
import { KIND_META } from "../graph/kindMeta";
import { problemPath } from "../graph/problemPath";

const NO_EVENTS: K8sEvent[] = [];
// Static class names: Tailwind only generates classes it can see in the source.
const TONE = {
  err: { box: "border-status-err/40 bg-status-err/10", text: "text-status-err" },
  warn: { box: "border-status-warn/40 bg-status-warn/10", text: "text-status-warn" },
} as const;

/** Why the selected object is yellow or red: the root cause of its problem chain, the chain as
 *  clickable steps, and the newest Warning event when the root has no message of its own. */
export function ProblemBlock({ nodeId }: { nodeId: NodeId }) {
  const { nodes, events, select } = useAppStore(useShallow((s) => ({
    nodes: s.nodes, events: s.details?.nodeId === nodeId ? s.details.events : NO_EVENTS, select: s.select,
  })));
  const node = nodes.get(nodeId);
  if (!node || (node.status !== "err" && node.status !== "warn")) return null;

  const path = problemPath(nodeId, nodes);
  const root = path.length > 0 ? nodes.get(path[path.length - 1])! : node;
  const warning = events.find((e) => e.type === "Warning");
  const reason = root.problem?.reason ?? warning?.reason;
  if (!reason) return null;
  // The root's own message wins; without one the newest Warning event stands in. When the node
  // has no problem at all, the event's reason is the title and its message the text.
  const own = root.problem?.message ?? null;
  const event = own === null && warning ? (root.problem ? `${warning.reason} — ${warning.message}` : warning.message) : null;
  const tone = root.status === "err" ? TONE.err : TONE.warn;

  return (
    <section role="status" aria-label="Problem" className={`mb-6 rounded-card border px-4 py-3 text-sm ${tone.box}`}>
      <div className={`font-semibold ${tone.text}`}>{reason}</div>
      {own && <div className="mt-1 break-words text-text-hi">{own}</div>}
      {event && <div className="mt-1 break-words text-text-hi">{event}</div>}
      {event && <div className="mt-1 text-xs text-text-muted">from Events</div>}
      {path.length > 1 && (
        <ol aria-label="Path" className="mt-3 flex flex-wrap items-center gap-1.5">
          {path.map((id, i) => {
            const step = nodes.get(id)!;
            return (
              <li key={id} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden className="text-text-muted">→</span>}
                <button type="button" onClick={() => void select(id)}
                  className="rounded-lg border border-border bg-surface px-2 py-0.5 text-xs text-accent hover:border-accent hover:text-text-hi">
                  {`${KIND_META[step.kind].label} ${step.name}`}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Put it at the top of Overview**

Replace `src/features/details/OverviewTab.tsx` with:

```tsx
import { useAppStore } from "../../app/store";
import type { NodeId, ObjectDetails } from "../../shared/ipc/types";
import { KIND_META } from "../graph/kindMeta";
import { ProblemBlock } from "./ProblemBlock";

export function OverviewTab({ nodeId, data }: { nodeId: NodeId; data: ObjectDetails }) {
  const nodes = useAppStore((s) => s.nodes);
  const select = useAppStore((s) => s.select);
  const related = data.related.map((id: NodeId) => nodes.get(id)).filter((n) => n !== undefined);
  return (
    <div className="h-full overflow-auto p-6 selectable">
      <ProblemBlock nodeId={nodeId} />
      <div className="grid grid-cols-[1fr_280px] gap-6">
        <dl className="grid content-start grid-cols-[max-content_1fr] gap-x-8 gap-y-2 text-sm">
          {data.summary.map(([k, v], i) => (
            <div key={`${k}-${i}`} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="break-all text-text-hi">{v || "—"}</dd>
            </div>
          ))}
        </dl>
        <div>
          <div className="mb-3 text-xs text-text-muted">Related</div>
          <ul className="space-y-1.5">
            {related.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => void select(n.id)} className="w-full truncate rounded-lg border border-border bg-surface px-3 py-1.5 text-left text-sm text-accent hover:border-accent hover:text-text-hi">
                  <span className="text-text-muted">{KIND_META[n.kind].short}</span>&nbsp; {n.name}
                </button>
              </li>
            ))}
            {related.length === 0 && <li className="text-xs text-text-muted">Nothing connected.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
```

In `src/features/details/DetailsPanel.tsx`, change `<OverviewTab data={details.data} />` to `<OverviewTab nodeId={details.nodeId} data={details.data} />`.

- [ ] **Step 5: Run the tests**

Run: `rtk proxy pnpm vitest run src/features/details && rtk proxy pnpm typecheck`
Expected: pass (the existing DetailsPanel tests use a healthy pod, so no block appears there).

- [ ] **Step 6: Commit**

```bash
git add src/features/details/ProblemBlock.tsx src/features/details/ProblemBlock.test.tsx src/features/details/OverviewTab.tsx src/features/details/DetailsPanel.tsx
git commit -m "$(cat <<'EOF'
Show why the selected object is unhealthy at the top of Overview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 9: Highlight the problem path on the graph

**Files:**
- Modify: `src/features/graph/toFlow.ts`, `RelationEdge.tsx`, `ResourceNode.tsx`, and `toFlow.test.ts`, `RelationEdge.test.tsx`, `ResourceNode.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `src/features/graph/toFlow.test.ts`, add inside `describe("toFlow")`:

```ts
  it("tints the selected node's problem path in its status colour", () => {
    const dep: GraphNode = { ...n("Deployment/p/bad", "Deployment"), status: "warn", problem: { reason: "1 of 1 not ready", message: null, cause: "Pod/p/bad-1" } };
    const pod: GraphNode = { ...n("Pod/p/bad-1", "Pod"), status: "err", problem: { reason: "ImagePullBackOff", message: null, cause: null } };
    const svc = n("Service/p/bad", "Service");
    const owns = e(dep.id, pod.id, "owns");
    const sel = e(svc.id, pod.id, "selects");
    const input = {
      nodes: new Map([dep, pod, svc].map((x) => [x.id, x])), edges: new Map([owns, sel].map((x) => [x.id, x])),
      hiddenKinds: new Set<GraphNode["kind"]>(), search: "", hoveredId: null, expandedGroups: new Set<string>(),
    };
    const f = toFlow({ ...input, selectedId: dep.id });
    const node = Object.fromEntries(f.nodes.map((x) => [x.id, x.data]));
    const edge = Object.fromEntries(f.edges.map((x) => [x.id, x.data]));
    expect(node[dep.id].pathTone).toBe("warn");
    expect(node[pod.id].pathTone).toBe("warn");
    expect(node[svc.id].pathTone).toBeUndefined();
    expect(edge[owns.id].pathTone).toBe("warn");
    expect(edge[sel.id].pathTone).toBeUndefined();

    const none = toFlow({ ...input, selectedId: svc.id });
    expect(none.edges.every((x) => x.data.pathTone === undefined)).toBe(true);
  });
```

In `src/features/graph/RelationEdge.test.tsx`, add:

```tsx
  it("draws a problem path edge in the status colour, never dimmed", () => {
    const { container } = render(
      <svg>
        <RelationEdge {...props} data={{ edge, highlighted: false, dimmed: true, pathTone: "err" }} />
      </svg>,
    );
    const path = container.querySelector("path") as SVGPathElement;
    expect(path.style.stroke).toBe("var(--color-status-err)");
    expect(path.style.opacity).toBe("1");
  });
```

In `src/features/graph/ResourceNode.test.tsx`, add:

```tsx
  it("outlines a node on the selected problem path in its status colour", () => {
    render(<ResourceCard node={node} dimmed={false} expanded={false} selected={false} pathTone="err" />);
    expect(screen.getByTestId("resource-card").className).toContain("border-status-err");
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `rtk proxy pnpm vitest run src/features/graph`
Expected: FAIL — `pathTone` is undefined / not a prop.

- [ ] **Step 3: Implement**

In `src/features/graph/toFlow.ts`:

```ts
import { problemPath } from "./problemPath";

/** Status colour of the selected node's problem path. */
export type PathTone = "err" | "warn";
```

add `pathTone?: PathTone;` to both `ResourceNodeData` and `RelationEdgeData`, and update the cached factories:

```ts
function nodeData(node: GraphNode, dimmed: boolean, expanded: boolean, pathTone: PathTone | undefined): ResourceNodeData {
  const cached = nodeDataCache.get(node);
  if (cached && cached.dimmed === dimmed && cached.expanded === expanded && cached.pathTone === pathTone) return cached;
  const data: ResourceNodeData = pathTone ? { node, dimmed, expanded, pathTone } : { node, dimmed, expanded };
  nodeDataCache.set(node, data);
  return data;
}
```

```ts
function edgeData(edge: GraphEdge, highlighted: boolean, dimmed: boolean, waypoints: Position[] | undefined, pathTone: PathTone | undefined): RelationEdgeData {
  const cached = edgeDataCache.get(edge);
  if (cached && cached.highlighted === highlighted && cached.dimmed === dimmed && cached.pathTone === pathTone && sameWaypoints(cached.waypoints, waypoints)) return cached;
  const data: RelationEdgeData = { edge, highlighted, dimmed, ...(waypoints ? { waypoints } : {}), ...(pathTone ? { pathTone } : {}) };
  edgeDataCache.set(edge, data);
  return data;
}
```

In `toFlow()`, before building `nodes`:

```ts
  // The selected node's problem chain (only when it leads somewhere): its nodes and the edges
  // between consecutive steps are tinted in the selected node's status colour.
  const selected = input.selectedId !== null ? input.nodes.get(input.selectedId) : undefined;
  const tone: PathTone | undefined = selected?.status === "err" || selected?.status === "warn" ? selected.status : undefined;
  const path = tone && selected ? problemPath(selected.id, input.nodes) : [];
  const onPath = new Set(path.length > 1 ? path : []);
  const pathLinks = new Set(path.slice(1).map((to, i) => `${path[i]}\n${to}`));
```

pass `onPath.has(node.id) ? tone : undefined` as the new last argument of `nodeData(…)`, and in the edge map:

```ts
    const touches = hover !== null && (edge.source === hover || edge.target === hover);
    const pathTone = pathLinks.has(`${edge.source}\n${edge.target}`) ? tone : undefined;
    return {
      id: edge.id,
      type: "relation",
      source: edge.source,
      target: edge.target,
      data: edgeData(edge, touches, hover !== null && !touches, waypoints.get(edge.id), pathTone),
    };
```

In `src/features/graph/RelationEdge.tsx`, replace the `opacity` line and the `style`:

```tsx
  const tone = data?.pathTone;
  const opacity = tone ? 1 : data?.dimmed ? 0.15 : data?.highlighted ? 1 : 0.7;
  return (
    <BaseEdge
      path={path}
      style={{
        // Iron Edge at rest; the selection's wiring lights up in Lavender Spark; a problem path
        // takes the status colour.
        stroke: tone ? `var(--color-status-${tone})` : data?.highlighted ? "var(--color-accent)" : "var(--color-border-strong)",
        strokeWidth: tone || data?.highlighted ? 2 : 1.5,
        strokeDasharray: solid ? undefined : "6 4",
        opacity,
        transition: "opacity 150ms, stroke-width 150ms",
      }}
    />
  );
```

In `src/features/graph/ResourceNode.tsx`:

```tsx
import type { PathTone, ResourceFlowNode } from "./toFlow";

// Static class names: Tailwind only generates classes it can see in the source.
const PATH_RING: Record<PathTone, string> = {
  err: "border-status-err shadow-[0_0_0_1px_var(--color-status-err)]",
  warn: "border-status-warn shadow-[0_0_0_1px_var(--color-status-warn)]",
};
```

Change the `ResourceCard` signature to accept `pathTone?: PathTone` and its border expression to:

```tsx
        selected ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]" : pathTone ? PATH_RING[pathTone] : "inset-hairline border-border"
```

and pass it from `ResourceNode`: `<ResourceCard node={data.node} dimmed={data.dimmed} expanded={data.expanded} selected={!!selected} pathTone={data.pathTone} />`.

- [ ] **Step 4: Run the tests**

Run: `rtk proxy pnpm vitest run src/features/graph && rtk proxy pnpm typecheck`
Expected: pass, including the existing toFlow/RelationEdge/ResourceNode tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/graph/toFlow.ts src/features/graph/RelationEdge.tsx src/features/graph/ResourceNode.tsx src/features/graph/toFlow.test.ts src/features/graph/RelationEdge.test.tsx src/features/graph/ResourceNode.test.tsx
git commit -m "$(cat <<'EOF'
Highlight the selected object's problem path on the graph

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 10: README and full checks

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature**

In `README.md`, in the **Graph.** bullet list (after "Status dots and badges show what is healthy, degraded or failing."), add:

```markdown
- Select a yellow or red object to see why. Overview starts with the reason and the Kubernetes message behind it, plus the chain of objects that leads to the root cause (for example Deployment → Pod → `ImagePullBackOff`), and that chain is highlighted on the graph.
```

- [ ] **Step 2: Run every check CI runs**

```bash
rtk proxy pnpm typecheck
rtk proxy pnpm test
cd src-tauri
rtk proxy cargo fmt --check
rtk proxy cargo clippy --all-targets -- -D warnings
rtk proxy cargo test
WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored
```

Expected: all green. Fix anything `cargo fmt --check` reports with `cargo fmt` and re-run. The smoke test only with the local `docker-desktop` context.

- [ ] **Step 3: Live check in the app**

With the demo namespaces (`examples/demo/setup.sh` on docker-desktop) run `pnpm tauri dev`, open `shop` and check:
1. Select `bad-image`: the Problem block says `ImagePullBackOff` (or `ErrImagePull`) with the pull message and the path `Deployment bad-image → Pod …`; the Deployment–Pod edge and the pod are outlined in red/amber.
2. Select `crasher`: `CrashLoopBackOff` with `last exit code …`.
3. Select the `web` HPA: if metrics-server is missing, a yellow block with `FailedGetResourceMetric` and its message.
4. Select a healthy Deployment: no block, no tint.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Document the problem explanation in the README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

## Deviations from the spec

1. **`problem()` takes the store** — `problem(obj, status, store)`, because the Service and Ingress reasons need to look at pods and Services.
2. **Small status changes are needed for the spec's flows.** Today a Service is only yellow when its selector matches nothing, an Ingress is never yellow and an HPA is yellow only on `ScalingLimited`. To have a problem at all (problems exist only on Warn/Err nodes) the plan makes a Service yellow when none of its matched pods is ready (a pod without a `Ready` condition counts as ready, so fixtures stay green), an Ingress yellow when a backend Service is missing, and an HPA yellow on `ScalingActive=False` / `AbleToScale=False` too. The `relations` fixture's Ingress (it routes to `does-not-exist`) turns yellow.
3. **A Service's path goes to its pods, not through the Deployment.** `selects` edges point at Pods / PodGroups, so the chain is `Service → Pod group (…)`; the spec's example `Service → Deployment → Pod group` is not how the graph is wired.
4. **Ingresses get no `cause`.** An Ingress is only yellow when a backend is missing (*Backend not found*, no cause by spec), so the `routes` link the spec describes would never fire; it is left out.
5. **Extra rows** for states the table did not cover but that make a node yellow: a workload yellow only because a rollout runs gets `Rolling out`; a Running pod with unready containers gets `Not ready` (`containers not ready: b`); a terminating pod gets `Terminating`. For a container terminated with its reason (`Error`, `OOMKilled`) the message is `exit code N[: message]`.
6. **`problemPath` lives in `src/features/graph/`**, not `src/features/details/`, because both the graph (`toFlow`) and the details panel use it and details already imports from graph.
7. **No problem for `Unknown`/`Ok` nodes and none for ConfigMap/Secret/PV/ServiceAccount**, which are never yellow or red.
