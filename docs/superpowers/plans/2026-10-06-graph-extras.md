# NetworkPolicies, RBAC and Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch NetworkPolicy, Role, RoleBinding, ClusterRole, ClusterRoleBinding and Node, and draw `applies` / `allows` / `grants` / `subject` / `runsOn` edges so policies, RBAC and nodes are visible on the graph, in tables and in the navigator.

**Architecture:** Six new `store::Kind` variants flow through the existing pipeline unchanged: `watch_plan` already plans cluster-scoped kinds as one cluster stream, `spawn_stream` gets one arm per kind, `graph::relations` gets three edge builders, `graph::build` filters cluster-scoped RBAC/Nodes to the ones that touch the scope (like bound PVs), `graph::status` adds Node health/problems, a `policy` pod badge, pod → node causes and Overview rule text. The frontend only needs the new kind/relation names, metadata, chip defaults, navigator sections, edge styles and Create templates.

**Tech Stack:** Rust (kube 4.2, k8s-openapi 0.28 `networking::v1`, `rbac::v1`, `core::v1::Node`), React/TS + zustand + React Flow, Vitest.

---

## File map

| File | Change |
|---|---|
| `src-tauri/src/graph/selector.rs` (new) | `label_selector_matches`, `selector_text` |
| `src-tauri/src/graph/mod.rs` | `pub mod selector;` |
| `src-tauri/src/store/mod.rs` | six `Kind` + `Object` variants, `WATCHED: [Kind; 21]`, `is_cluster_scoped` |
| `src-tauri/src/store/yaml.rs` | `de!` arms |
| `src-tauri/src/session/write.rs` | `api_resource` arms |
| `src-tauri/src/session/watch.rs` | `into_object!` lines, `spawn_stream` arms |
| `src-tauri/src/session/scope.rs` | plan-size test counts all cluster-scoped kinds |
| `src-tauri/src/graph/rows.rs` | columns + cells for the six kinds |
| `src-tauri/src/graph/model.rs` | `Relation::{Applies, Allows, Grants, Subject, RunsOn}` |
| `src-tauri/src/graph/relations.rs` | `network_policy_edges`, `rbac_edges`, `node_edges` |
| `src-tauri/src/graph/build.rs` | `retain_connected_cluster_objects`, pod → node cause |
| `src-tauri/src/graph/status.rs` | Node describe/problem, `policy` badge, summaries |
| `src-tauri/tests/fixtures/graph-extras.yaml` (new) | fixture for every new rule |
| `src-tauri/tests/fixtures/smoke.yaml` | NetworkPolicy, Role, RoleBinding |
| `src-tauri/tests/{ipc_fixtures.rs,smoke.rs}`, `src/shared/ipc/fixtures/graph_extras.json` (new), `docs/ipc-contract.md` | contract |
| `src/shared/ipc/types.ts` | `KINDS`, `RELATIONS` |
| `src/features/graph/{kindMeta.ts,layout.ts,RelationEdge.tsx}` | metadata, layers, edge styles |
| `src/features/navigator/{kindTree.ts,sectionIcons.ts}` | sections |
| `src/features/editor/templates.ts` | templates for NetworkPolicy, Role, RoleBinding |
| `src/app/store.ts` | default hidden kinds |
| `README.md` | Graph section |

Node ids follow `node_id`: cluster-scoped kinds have an empty namespace segment, e.g. `Node//node-a`, `ClusterRole//view`. Edge ids are `{source}->{target}:{relation}`.

---

### Task 1: Label selector matcher

**Files:**
- Create: `src-tauri/src/graph/selector.rs`
- Modify: `src-tauri/src/graph/mod.rs`

- [ ] **Step 1: Write the failing tests** — create `src-tauri/src/graph/selector.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, LabelSelectorRequirement};
    use std::collections::BTreeMap;

    fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn expr(key: &str, op: &str, values: &[&str]) -> LabelSelectorRequirement {
        LabelSelectorRequirement {
            key: key.into(),
            operator: op.into(),
            values: if values.is_empty() { None } else { Some(values.iter().map(|v| v.to_string()).collect()) },
        }
    }

    #[test]
    fn an_empty_selector_matches_everything() {
        let all = LabelSelector::default();
        assert!(label_selector_matches(&all, Some(&labels(&[("app", "web")]))));
        assert!(label_selector_matches(&all, None));
        assert_eq!(selector_text(&all), "all pods");
    }

    #[test]
    fn match_labels_must_all_be_present() {
        let sel = LabelSelector { match_labels: Some(labels(&[("app", "web"), ("tier", "fe")])), ..Default::default() };
        assert!(label_selector_matches(&sel, Some(&labels(&[("app", "web"), ("tier", "fe"), ("x", "y")]))));
        assert!(!label_selector_matches(&sel, Some(&labels(&[("app", "web")]))));
        assert!(!label_selector_matches(&sel, None));
    }

    #[test]
    fn every_operator() {
        let l = labels(&[("env", "prod"), ("team", "a")]);
        let one = |e: LabelSelectorRequirement| LabelSelector { match_expressions: Some(vec![e]), ..Default::default() };
        assert!(label_selector_matches(&one(expr("env", "In", &["prod", "stage"])), Some(&l)));
        assert!(!label_selector_matches(&one(expr("env", "In", &["dev"])), Some(&l)));
        assert!(label_selector_matches(&one(expr("env", "NotIn", &["dev"])), Some(&l)));
        assert!(!label_selector_matches(&one(expr("env", "NotIn", &["prod"])), Some(&l)));
        assert!(label_selector_matches(&one(expr("missing", "NotIn", &["x"])), Some(&l)));
        assert!(label_selector_matches(&one(expr("team", "Exists", &[])), Some(&l)));
        assert!(!label_selector_matches(&one(expr("missing", "Exists", &[])), Some(&l)));
        assert!(label_selector_matches(&one(expr("missing", "DoesNotExist", &[])), Some(&l)));
        assert!(!label_selector_matches(&one(expr("team", "DoesNotExist", &[])), Some(&l)));
        assert!(!label_selector_matches(&one(expr("team", "Bogus", &[])), Some(&l)), "unknown operators never match");
    }

    #[test]
    fn text_reads_like_kubectl() {
        let sel = LabelSelector {
            match_labels: Some(labels(&[("app", "web")])),
            match_expressions: Some(vec![expr("env", "In", &["prod", "stage"]), expr("canary", "DoesNotExist", &[])]),
        };
        assert_eq!(selector_text(&sel), "app=web, env in (prod,stage), !canary");
    }
}
```

and add `pub mod selector;` to `src-tauri/src/graph/mod.rs` (alphabetical, after `pub mod rows;`).

- [ ] **Step 2: Run it to see it fail**

Run: `cd src-tauri && cargo test --lib graph::selector`
Expected: compile error — `label_selector_matches` / `selector_text` not found.

- [ ] **Step 3: Implement** — put this above the test module:

```rust
//! Kubernetes label selectors (`matchLabels` + `matchExpressions`), as NetworkPolicies use them.
//! Unlike a Service's plain map selector, an empty `LabelSelector` matches every object.

use std::collections::BTreeMap;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;

pub fn label_selector_matches(sel: &LabelSelector, labels: Option<&BTreeMap<String, String>>) -> bool {
    let empty = BTreeMap::new();
    let labels = labels.unwrap_or(&empty);
    let by_labels = sel
        .match_labels
        .as_ref()
        .is_none_or(|m| m.iter().all(|(k, v)| labels.get(k) == Some(v)));
    by_labels
        && sel.match_expressions.iter().flatten().all(|r| {
            let values = r.values.as_deref().unwrap_or_default();
            let value = labels.get(&r.key);
            match r.operator.as_str() {
                "In" => value.is_some_and(|v| values.contains(v)),
                "NotIn" => value.is_none_or(|v| !values.contains(v)),
                "Exists" => value.is_some(),
                "DoesNotExist" => value.is_none(),
                _ => false,
            }
        })
}

/// `app=web, env in (prod,stage), !canary`; `all pods` for an empty selector.
pub fn selector_text(sel: &LabelSelector) -> String {
    let mut parts: Vec<String> = sel.match_labels.iter().flatten().map(|(k, v)| format!("{k}={v}")).collect();
    for r in sel.match_expressions.iter().flatten() {
        let values = r.values.as_deref().unwrap_or_default().join(",");
        parts.push(match r.operator.as_str() {
            "In" => format!("{} in ({values})", r.key),
            "NotIn" => format!("{} notin ({values})", r.key),
            "Exists" => r.key.clone(),
            "DoesNotExist" => format!("!{}", r.key),
            op => format!("{} {op} ({values})", r.key),
        });
    }
    if parts.is_empty() {
        "all pods".into()
    } else {
        parts.join(", ")
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib graph::selector && cargo clippy --all-targets -- -D warnings`
Expected: 4 passed; clippy may flag the functions as dead code until Task 3 — if so add `#[allow(dead_code)]` on the two functions with a `// used from Task 3` note and remove it in Task 3.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/graph/selector.rs src-tauri/src/graph/mod.rs
git commit -m "$(cat <<'EOF'
Add a Kubernetes label selector matcher

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 2: Six new kinds — store, watch, API resources, rows

**Files:**
- Create: `src-tauri/tests/fixtures/graph-extras.yaml`
- Modify: `src-tauri/src/store/mod.rs`, `src-tauri/src/store/yaml.rs`, `src-tauri/src/session/write.rs`, `src-tauri/src/session/watch.rs`, `src-tauri/src/session/scope.rs`, `src-tauri/src/graph/status.rs`, `src-tauri/src/graph/rows.rs`

- [ ] **Step 1: Add the fixture** `src-tauri/tests/fixtures/graph-extras.yaml` (also used by Tasks 3–5; the `status.rs` invariant test loads every fixture, so every Warn/Err object here must get a problem by Task 5 — until then the new kinds are Ok and the two existing-kind objects already satisfy it):

```yaml
apiVersion: v1
kind: Pod
metadata: { name: web-1, namespace: s, labels: { app: web } }
spec: { nodeName: node-a, serviceAccountName: web, containers: [ { name: c, image: x } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: client-1, namespace: s, labels: { app: client } }
spec: { nodeName: node-b, containers: [ { name: c, image: x } ] }
status: { phase: Pending }
---
apiVersion: v1
kind: Pod
metadata: { name: other-1, namespace: t, labels: { app: client } }
spec: { nodeName: node-a, containers: [ { name: c, image: x } ] }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: web, namespace: s }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: web-ingress, namespace: s }
spec:
  podSelector: { matchLabels: { app: web } }
  policyTypes: [ Ingress ]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: client } }
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: t } }
          podSelector: { matchLabels: { app: client } }
        - ipBlock: { cidr: 10.0.0.0/8 }
      ports: [ { protocol: TCP, port: 80 } ]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: deny-all, namespace: s }
spec: { podSelector: {}, policyTypes: [ Ingress ] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: reader, namespace: s }
rules:
  - { apiGroups: [ "" ], resources: [ pods, services ], verbs: [ get, list ] }
  - { apiGroups: [ apps ], resources: [ deployments ], verbs: [ "*" ] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: web-reader, namespace: s }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: reader }
subjects:
  - { kind: ServiceAccount, name: web, namespace: s }
  - { kind: User, name: alice, apiGroup: rbac.authorization.k8s.io }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: web-view, namespace: s }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [ { kind: ServiceAccount, name: web } ]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: view }
rules: [ { apiGroups: [ "" ], resources: [ pods ], verbs: [ get ] } ]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: unused }
rules: [ { nonResourceURLs: [ /healthz ], verbs: [ get ] } ]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: web-cluster }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [ { kind: ServiceAccount, name: web, namespace: s } ]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: system-only }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: unused }
subjects: [ { kind: Group, name: "system:masters", apiGroup: rbac.authorization.k8s.io } ]
---
apiVersion: v1
kind: Node
metadata: { name: node-a, labels: { node-role.kubernetes.io/control-plane: "" } }
status:
  nodeInfo: { architecture: arm64, bootID: b, containerRuntimeVersion: c, kernelVersion: k, kubeProxyVersion: v1.36.1, kubeletVersion: v1.36.1, machineID: m, operatingSystem: linux, osImage: Linux, systemUUID: u }
  conditions: [ { type: Ready, status: "True" } ]
---
apiVersion: v1
kind: Node
metadata: { name: node-b }
status:
  nodeInfo: { architecture: arm64, bootID: b, containerRuntimeVersion: c, kernelVersion: k, kubeProxyVersion: v1.36.1, kubeletVersion: v1.36.1, machineID: m, operatingSystem: linux, osImage: Linux, systemUUID: u }
  conditions: [ { type: Ready, status: "Unknown", reason: NodeStatusUnknown, message: Kubelet stopped posting node status. } ]
---
apiVersion: v1
kind: Node
metadata: { name: node-c }
status:
  nodeInfo: { architecture: arm64, bootID: b, containerRuntimeVersion: c, kernelVersion: k, kubeProxyVersion: v1.36.1, kubeletVersion: v1.36.1, machineID: m, operatingSystem: linux, osImage: Linux, systemUUID: u }
  conditions:
    - { type: Ready, status: "True" }
    - { type: MemoryPressure, status: "True", reason: KubeletHasInsufficientMemory, message: kubelet has insufficient memory available }
```

> If `kubectl`/k8s-openapi 0.28 rejects a field (e.g. `NodeSystemInfo` gained another required field), add it with a dummy value; the fixture only has to deserialize.

- [ ] **Step 2: Write the failing tests**

In `src-tauri/src/store/mod.rs` tests:

```rust
    #[test]
    fn the_six_new_kinds_parse_and_cluster_scope_correctly() {
        for (s, cluster) in [
            ("NetworkPolicy", false), ("Role", false), ("RoleBinding", false),
            ("ClusterRole", true), ("ClusterRoleBinding", true), ("Node", true),
        ] {
            let k = Kind::parse(s).unwrap_or_else(|| panic!("{s} does not parse"));
            assert_eq!(k.as_str(), s);
            assert_eq!(k.is_cluster_scoped(), cluster, "{s}");
        }
        assert_eq!(Kind::WATCHED.len(), 21);
    }

    #[test]
    fn the_extras_fixture_loads() {
        let s = Store::from_fixture("graph-extras").unwrap();
        assert_eq!(s.iter_kind(Kind::NetworkPolicy).count(), 2);
        assert_eq!(s.iter_kind(Kind::Node).count(), 3);
        assert!(s.find(Kind::ClusterRole, Some("ignored"), "view").is_some(), "cluster-scoped lookups ignore the namespace");
    }
```

In `src-tauri/src/graph/rows.rs` tests:

```rust
    #[test]
    fn the_new_kinds_have_kubectl_columns() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let nodes = table(&s, Kind::Node, now());
        assert_eq!(cell(&nodes, "node-a", "status").text, "Ready");
        assert_eq!(cell(&nodes, "node-a", "roles").text, "control-plane");
        assert_eq!(cell(&nodes, "node-a", "version").text, "v1.36.1");
        assert_eq!(cell(&nodes, "node-a", "pods").text, "2");
        assert_eq!(cell(&nodes, "node-b", "status").text, "NotReady");
        assert_eq!(cell(&nodes, "node-c", "roles").text, "<none>");
        let policies = table(&s, Kind::NetworkPolicy, now());
        assert_eq!(cell(&policies, "web-ingress", "podSelector").text, "app=web");
        assert_eq!(cell(&policies, "deny-all", "podSelector").text, "all pods");
        assert_eq!(cell(&policies, "web-ingress", "policyTypes").text, "Ingress");
        assert_eq!(cell(&table(&s, Kind::Role, now()), "reader", "rules").text, "2");
        let bindings = table(&s, Kind::RoleBinding, now());
        assert_eq!(cell(&bindings, "web-reader", "role").text, "Role/reader");
        assert_eq!(cell(&bindings, "web-reader", "subjects").text, "ServiceAccount s/web, User alice");
        assert_eq!(cell(&table(&s, Kind::ClusterRoleBinding, now()), "web-cluster", "role").text, "ClusterRole/view");
    }
```

(`cell(t, name, col)` is the existing helper at the bottom of the rows tests.)

- [ ] **Step 3: Run to see them fail**

Run: `cd src-tauri && cargo test --lib store:: graph::rows`
Expected: compile errors — no `Kind::NetworkPolicy` etc.

- [ ] **Step 4: Implement the store** — `src-tauri/src/store/mod.rs`:

  - Imports: extend to
    ```rust
    use k8s_openapi::api::core::v1::{ConfigMap, Node, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service, ServiceAccount};
    use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
    use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
    ```
  - `enum Kind`: after `HorizontalPodAutoscaler,` add `NetworkPolicy, Role, RoleBinding, ClusterRole, ClusterRoleBinding, Node,` (keep `PodGroup` last).
  - `WATCHED: [Kind; 21]`: append `Kind::NetworkPolicy, Kind::Role, Kind::RoleBinding, Kind::ClusterRole, Kind::ClusterRoleBinding, Kind::Node,`.
  - `as_str`: `Kind::NetworkPolicy => "NetworkPolicy", Kind::Role => "Role", Kind::RoleBinding => "RoleBinding", Kind::ClusterRole => "ClusterRole", Kind::ClusterRoleBinding => "ClusterRoleBinding", Kind::Node => "Node",`.
  - `is_cluster_scoped`: `matches!(self, Kind::PersistentVolume | Kind::ClusterRole | Kind::ClusterRoleBinding | Kind::Node)`.
  - `enum Object`: add `NetworkPolicy(NetworkPolicy), Role(Role), RoleBinding(RoleBinding), ClusterRole(ClusterRole), ClusterRoleBinding(ClusterRoleBinding), Node(Node),`.
  - `for_each_object!`: add the six arms (`Object::NetworkPolicy($o) => $body,` …).
  - `Object::kind`: add the six arms (`Object::NetworkPolicy(_) => Kind::NetworkPolicy,` …).

- [ ] **Step 5: YAML loader** — `src-tauri/src/store/yaml.rs`: add before `Kind::PodGroup`:
  ```rust
            Kind::NetworkPolicy => de!(NetworkPolicy),
            Kind::Role => de!(Role),
            Kind::RoleBinding => de!(RoleBinding),
            Kind::ClusterRole => de!(ClusterRole),
            Kind::ClusterRoleBinding => de!(ClusterRoleBinding),
            Kind::Node => de!(Node),
  ```

- [ ] **Step 6: API resources** — `src-tauri/src/session/write.rs` `api_resource`: add the six `erase!` arms (`Kind::NetworkPolicy => erase!(NetworkPolicy),` …), extending the file's `k8s_openapi` imports with `networking::v1::NetworkPolicy`, `rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding}` and `core::v1::Node`. The existing `every_watched_kind_has_an_api_resource` test then covers them.

- [ ] **Step 7: Watchers** — `src-tauri/src/session/watch.rs`:
  - `into_object!`: append
    ```rust
    k8s_openapi::api::networking::v1::NetworkPolicy => NetworkPolicy,
    k8s_openapi::api::rbac::v1::Role => Role,
    k8s_openapi::api::rbac::v1::RoleBinding => RoleBinding,
    k8s_openapi::api::rbac::v1::ClusterRole => ClusterRole,
    k8s_openapi::api::rbac::v1::ClusterRoleBinding => ClusterRoleBinding,
    k8s_openapi::api::core::v1::Node => Node,
    ```
  - `spawn_stream`: add `rbac::v1 as rbac` to the `use k8s_openapi::api::{…}` list and the arms
    ```rust
        Kind::NetworkPolicy => spawn_namespaced::<networking::NetworkPolicy>(client, stream, namespaces, tx),
        Kind::Role => spawn_namespaced::<rbac::Role>(client, stream, namespaces, tx),
        Kind::RoleBinding => spawn_namespaced::<rbac::RoleBinding>(client, stream, namespaces, tx),
        Kind::ClusterRole => spawn_watch(Api::<rbac::ClusterRole>::all(client.clone()), stream.clone(), tx.clone()),
        Kind::ClusterRoleBinding => spawn_watch(Api::<rbac::ClusterRoleBinding>::all(client.clone()), stream.clone(), tx.clone()),
        Kind::Node => spawn_watch(Api::<core::Node>::all(client.clone()), stream.clone(), tx.clone()),
    ```
  `watch_plan` already plans cluster-scoped kinds as one cluster stream — nothing to change there.

- [ ] **Step 8: Fix the plan-size test** — `src-tauri/src/session/scope.rs` `plan_is_per_namespace_for_sets_and_cluster_wide_for_all`: replace the two-namespace assertion with
  ```rust
        let cluster = Kind::WATCHED.iter().filter(|k| k.is_cluster_scoped()).count();
        assert_eq!(two.len(), (Kind::WATCHED.len() - cluster) * 2 + cluster);
  ```

- [ ] **Step 9: Status placeholder** — `src-tauri/src/graph/status.rs` `base_describe`: add before the closing brace
  ```rust
        // Real Node health arrives with the status task; policies and RBAC objects are always ok.
        Object::NetworkPolicy(_) | Object::Role(_) | Object::RoleBinding(_) | Object::ClusterRole(_) | Object::ClusterRoleBinding(_) | Object::Node(_) => (Status::Ok, vec![]),
  ```
  (`problem` and `summary` already end in `_ =>` arms.)

- [ ] **Step 10: Rows** — `src-tauri/src/graph/rows.rs`:
  - `columns`: before `Kind::PodGroup`
    ```rust
        Kind::NetworkPolicy => vec![name(), col("podSelector", "Pod selector", false), col("policyTypes", "Policy types", false), age_c()],
        Kind::Role | Kind::ClusterRole => vec![name(), col("rules", "Rules", true), age_c()],
        Kind::RoleBinding | Kind::ClusterRoleBinding => vec![name(), col("role", "Role", false), col("subjects", "Subjects", false), age_c()],
        Kind::Node => vec![
            name(),
            col("status", "Status", false),
            col("roles", "Roles", false),
            col("version", "Version", false),
            col("pods", "Pods", true),
            age_c(),
        ],
    ```
  - `kind_cells`: before `Object::ServiceAccount(_) => …` add
    ```rust
        Object::NetworkPolicy(np) => {
            let spec = np.spec.as_ref();
            vec![
                plain(spec.map(|s| crate::graph::selector::selector_text(&s.pod_selector)).unwrap_or_default()),
                plain(spec.and_then(|s| s.policy_types.as_ref()).map(|t| t.join(", ")).unwrap_or_else(|| "Ingress".into())),
                age_cell,
            ]
        }
        Object::Role(r) => vec![plain(r.rules.as_ref().map_or(0, |v| v.len()).to_string()), age_cell],
        Object::ClusterRole(r) => vec![plain(r.rules.as_ref().map_or(0, |v| v.len()).to_string()), age_cell],
        Object::RoleBinding(b) => vec![
            plain(format!("{}/{}", b.role_ref.kind, b.role_ref.name)),
            plain(subjects_text(b.subjects.as_deref().unwrap_or_default())),
            age_cell,
        ],
        Object::ClusterRoleBinding(b) => vec![
            plain(format!("{}/{}", b.role_ref.kind, b.role_ref.name)),
            plain(subjects_text(b.subjects.as_deref().unwrap_or_default())),
            age_cell,
        ],
        Object::Node(n) => {
            let pods = store
                .iter_kind(Kind::Pod)
                .filter(|p| matches!(p, Object::Pod(p) if p.spec.as_ref().and_then(|s| s.node_name.as_deref()) == Some(obj.name())))
                .count();
            vec![
                coloured(node_ready_text(n), status),
                plain(node_roles(n)),
                plain(n.status.as_ref().and_then(|s| s.node_info.as_ref()).map(|i| i.kubelet_version.clone()).unwrap_or_default()),
                plain(pods.to_string()),
                age_cell,
            ]
        }
    ```
  - Helpers below `join` (they are reused by `status.rs` in Task 5, hence `pub(crate)`):
    ```rust
    /// `ServiceAccount s/web, User alice`.
    pub(crate) fn subjects_text(subjects: &[k8s_openapi::api::rbac::v1::Subject]) -> String {
        subjects
            .iter()
            .map(|s| match &s.namespace {
                Some(ns) => format!("{} {ns}/{}", s.kind, s.name),
                None => format!("{} {}", s.kind, s.name),
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// `Ready`, `NotReady` (Ready condition not True) or `Unknown` (no Ready condition).
    pub(crate) fn node_ready_text(n: &k8s_openapi::api::core::v1::Node) -> String {
        let ready = n.status.as_ref().and_then(|s| s.conditions.as_ref()).and_then(|cs| cs.iter().find(|c| c.type_ == "Ready"));
        match ready {
            Some(c) if c.status == "True" => "Ready".into(),
            Some(_) => "NotReady".into(),
            None => "Unknown".into(),
        }
    }

    /// Roles from `node-role.kubernetes.io/<role>` labels, `<none>` like kubectl.
    pub(crate) fn node_roles(n: &k8s_openapi::api::core::v1::Node) -> String {
        let roles: Vec<&str> = n
            .metadata
            .labels
            .iter()
            .flatten()
            .filter_map(|(k, _)| k.strip_prefix("node-role.kubernetes.io/"))
            .collect();
        if roles.is_empty() { "<none>".into() } else { roles.join(",") }
    }
    ```
  > `NetworkPolicySpec.pod_selector` is a required `LabelSelector` in k8s-openapi 0.28; if it is `Option<LabelSelector>` in the resolved version, use `s.pod_selector.as_ref().map(selector_text)` and treat `None` as "all pods" everywhere (Tasks 3 and 5 too).

- [ ] **Step 11: Run the checks**

Run: `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: all pass, including the new tests, `every_watched_kind_has_an_api_resource`, the plan-size test and the status invariant test (new kinds are Ok without problems; `client-1` is Pending and already has a problem).

- [ ] **Step 12: Commit**

```bash
git add src-tauri/src src-tauri/tests/fixtures/graph-extras.yaml
git commit -m "$(cat <<'EOF'
Watch NetworkPolicies, Roles, bindings and Nodes, with tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
EOF
)"
```

---

### Task 3: Relations — applies, allows, grants, subject, runsOn

**Files:**
- Modify: `src-tauri/src/graph/model.rs`, `src-tauri/src/graph/relations.rs`

- [ ] **Step 1: Failing tests** — in `relations.rs` tests:

```rust
    #[test]
    fn network_policies_apply_to_their_pods_and_admit_ingress_peers() {
        let s = Store::from_fixture("graph-extras").unwrap();
        assert_eq!(
            ids(&network_policy_edges(&s)),
            vec![
                "NetworkPolicy/s/deny-all->Pod/s/client-1:applies",
                "NetworkPolicy/s/deny-all->Pod/s/web-1:applies",
                "NetworkPolicy/s/web-ingress->Pod/s/web-1:applies",
                "Pod/s/client-1->NetworkPolicy/s/web-ingress:allows",
                "Pod/t/other-1->NetworkPolicy/s/web-ingress:allows",
            ]
        );
    }

    #[test]
    fn bindings_grant_roles_to_service_accounts() {
        let s = Store::from_fixture("graph-extras").unwrap();
        assert_eq!(
            ids(&rbac_edges(&s)),
            vec![
                "ClusterRoleBinding//system-only->ClusterRole//unused:grants",
                "ClusterRoleBinding//web-cluster->ClusterRole//view:grants",
                "ClusterRoleBinding//web-cluster->ServiceAccount/s/web:subject",
                "RoleBinding/s/web-reader->Role/s/reader:grants",
                "RoleBinding/s/web-reader->ServiceAccount/s/web:subject",
                "RoleBinding/s/web-view->ClusterRole//view:grants",
                "RoleBinding/s/web-view->ServiceAccount/s/web:subject",
            ]
        );
    }

    #[test]
    fn pods_run_on_their_nodes() {
        let s = Store::from_fixture("graph-extras").unwrap();
        assert_eq!(
            ids(&node_edges(&s)),
            vec![
                "Pod/s/client-1->Node//node-b:runsOn",
                "Pod/s/web-1->Node//node-a:runsOn",
                "Pod/t/other-1->Node//node-a:runsOn",
            ]
        );
    }
```

Run: `cd src-tauri && cargo test --lib graph::relations` → compile errors (functions and relation names missing).

- [ ] **Step 2: Relation variants** — `model.rs` `enum Relation`, after `Scales`:

```rust
    #[serde(rename = "applies")]
    Applies,
    #[serde(rename = "allows")]
    Allows,
    #[serde(rename = "grants")]
    Grants,
    #[serde(rename = "subject")]
    Subject,
    #[serde(rename = "runsOn")]
    RunsOn,
```

and in `as_str`: `Relation::Applies => "applies", Relation::Allows => "allows", Relation::Grants => "grants", Relation::Subject => "subject", Relation::RunsOn => "runsOn",`.

- [ ] **Step 3: Edge builders** — `relations.rs` (imports: `use std::collections::BTreeMap;`, `use k8s_openapi::api::networking::v1::NetworkPolicyPeer;`, `use super::selector::label_selector_matches;`):

```rust
/// NetworkPolicy -> each pod its `podSelector` picks (`applies`), and pod -> policy for each pod
/// an ingress `from` peer admits (`allows`). ipBlock peers have no graph edge.
pub fn network_policy_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for obj in store.iter_kind(Kind::NetworkPolicy) {
        let Object::NetworkPolicy(np) = obj else { continue };
        let Some(spec) = np.spec.as_ref() else { continue };
        let policy = id_of(obj);
        for pod in store.iter_kind(Kind::Pod) {
            if pod.namespace() == obj.namespace() && label_selector_matches(&spec.pod_selector, pod.meta().labels.as_ref()) {
                edges.push(Edge::new(policy.clone(), id_of(pod), Relation::Applies));
            }
        }
        for peer in spec.ingress.iter().flatten().flat_map(|r| r.from.iter().flatten()) {
            if peer.pod_selector.is_none() && peer.namespace_selector.is_none() {
                continue;
            }
            for pod in store.iter_kind(Kind::Pod) {
                if peer_admits(peer, obj.namespace(), pod) {
                    edges.push(Edge::new(id_of(pod), policy.clone(), Relation::Allows));
                }
            }
        }
    }
    // A pod admitted by two peers of one policy is still one edge.
    edges.sort_by(|a, b| a.id.cmp(&b.id));
    edges.dedup_by(|a, b| a.id == b.id);
    edges
}

/// Namespaces are not watched, so a `namespaceSelector` is evaluated against the label every
/// namespace carries, `kubernetes.io/metadata.name`; selectors on other namespace labels match nothing.
fn peer_admits(peer: &NetworkPolicyPeer, policy_ns: Option<&str>, pod: &Object) -> bool {
    let in_namespace = match &peer.namespace_selector {
        None => pod.namespace() == policy_ns,
        Some(sel) => {
            let ns = BTreeMap::from([("kubernetes.io/metadata.name".to_string(), pod.namespace().unwrap_or_default().to_string())]);
            label_selector_matches(sel, Some(&ns))
        }
    };
    in_namespace && peer.pod_selector.as_ref().is_none_or(|sel| label_selector_matches(sel, pod.meta().labels.as_ref()))
}

/// RoleBinding/ClusterRoleBinding -> its roleRef (`grants`) and -> each ServiceAccount subject (`subject`).
pub fn rbac_edges(store: &Store) -> Vec<Edge> {
    let mut edges = vec![];
    for binding in store.iter_kind(Kind::RoleBinding).chain(store.iter_kind(Kind::ClusterRoleBinding)) {
        let (role_ref, subjects) = match binding {
            Object::RoleBinding(b) => (&b.role_ref, b.subjects.as_deref().unwrap_or_default()),
            Object::ClusterRoleBinding(b) => (&b.role_ref, b.subjects.as_deref().unwrap_or_default()),
            _ => continue,
        };
        let role = match role_ref.kind.as_str() {
            "Role" => store.find(Kind::Role, binding.namespace(), &role_ref.name),
            "ClusterRole" => store.find(Kind::ClusterRole, None, &role_ref.name),
            _ => None,
        };
        if let Some(role) = role {
            edges.push(Edge::new(id_of(binding), id_of(role), Relation::Grants));
        }
        for s in subjects.iter().filter(|s| s.kind == "ServiceAccount") {
            // A RoleBinding's ServiceAccount subject without a namespace is in the binding's own.
            let ns = s.namespace.as_deref().or(binding.namespace());
            if let Some(sa) = store.find(Kind::ServiceAccount, ns, &s.name) {
                edges.push(Edge::new(id_of(binding), id_of(sa), Relation::Subject));
            }
        }
    }
    edges
}

/// Pod -> the Node in `spec.nodeName` (`runsOn`).
pub fn node_edges(store: &Store) -> Vec<Edge> {
    store
        .iter_kind(Kind::Pod)
        .filter_map(|pod| {
            let Object::Pod(p) = pod else { return None };
            let node = store.find(Kind::Node, None, p.spec.as_ref()?.node_name.as_deref()?)?;
            Some(Edge::new(id_of(pod), id_of(node), Relation::RunsOn))
        })
        .collect()
}
```

and extend `all_edges` with `edges.extend(network_policy_edges(store)); edges.extend(rbac_edges(store)); edges.extend(node_edges(store));`. Remove any `#[allow(dead_code)]` added in Task 1.

- [ ] **Step 4: Run** — `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` → all pass. (The graph diff/ipc tests serialise relations by `as_str`, so no other change is needed.)

- [ ] **Step 5: Commit** — `git add src-tauri/src/graph && git commit` with message "Draw NetworkPolicy, RBAC and node edges" + the two trailers.

---

### Task 4: Only cluster-scoped objects that touch the scope

**Files:** Modify `src-tauri/src/graph/build.rs`

- [ ] **Step 1: Failing test** (build tests):

```rust
    #[test]
    fn cluster_scoped_rbac_and_nodes_only_show_when_connected() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let g = build(&s, &BuildOptions::default());
        let has = |id: &str| g.node(id).is_some();
        assert!(has("Node//node-a") && has("Node//node-b"), "nodes hosting pods stay");
        assert!(!has("Node//node-c"), "a node without pods here is hidden");
        assert!(has("ClusterRoleBinding//web-cluster"), "binds a ServiceAccount in the scope");
        assert!(!has("ClusterRoleBinding//system-only"), "only Group subjects");
        assert!(has("ClusterRole//view"), "granted by shown bindings");
        assert!(!has("ClusterRole//unused"), "only granted by a hidden binding");
        assert!(g.edges.iter().all(|e| g.node(&e.source).is_some() && g.node(&e.target).is_some()), "no dangling edges");
    }
```

Run → fails on `Node//node-c` / `system-only` / `unused` being present.

- [ ] **Step 2: Implement** — below `retain_bound_persistent_volumes`:

```rust
/// Cluster-scoped objects only appear when they touch the scope: a Node hosting a pod here, a
/// ClusterRoleBinding with a ServiceAccount subject here, a ClusterRole a shown binding grants.
/// Edges to what is dropped go too.
fn retain_connected_cluster_objects(nodes: &mut HashMap<NodeId, Node>, edges: &mut Vec<Edge>) {
    let kind_of = |id: &str| nodes.get(id).map(|n| n.kind);
    let hosting: HashSet<NodeId> = edges.iter().filter(|e| e.relation == Relation::RunsOn).map(|e| e.target.clone()).collect();
    let bound: HashSet<NodeId> = edges
        .iter()
        .filter(|e| e.relation == Relation::Subject && kind_of(&e.source) == Some(Kind::ClusterRoleBinding))
        .map(|e| e.source.clone())
        .collect();
    let granted: HashSet<NodeId> = edges
        .iter()
        .filter(|e| {
            e.relation == Relation::Grants
                && match kind_of(&e.source) {
                    Some(Kind::RoleBinding) => true,
                    Some(Kind::ClusterRoleBinding) => bound.contains(&e.source),
                    _ => false,
                }
        })
        .map(|e| e.target.clone())
        .collect();
    nodes.retain(|id, n| match n.kind {
        Kind::Node => hosting.contains(id),
        Kind::ClusterRoleBinding => bound.contains(id),
        Kind::ClusterRole => granted.contains(id),
        _ => true,
    });
    edges.retain(|e| nodes.contains_key(&e.source) && nodes.contains_key(&e.target));
}
```

and in `build`, right after `retain_bound_persistent_volumes(&mut nodes, &edges);` add `retain_connected_cluster_objects(&mut nodes, &mut edges);`.

- [ ] **Step 3: Run** — `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` → pass.
- [ ] **Step 4: Commit** — "Show cluster-scoped RBAC and Nodes only when they touch the scope" + trailers.

---

### Task 5: Node health, policy badge, pod → node cause, rule text

**Files:** Modify `src-tauri/src/graph/status.rs`, `src-tauri/src/graph/build.rs`

- [ ] **Step 1: Failing tests** — `status.rs` tests:

```rust
    #[test]
    fn node_health_and_problems() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let node = |n: &str| s.find(Kind::Node, None, n).unwrap();
        assert_eq!(describe(node("node-a"), &s), (Status::Ok, strs(&["Ready", "v1.36.1"])));
        let (st, _) = describe(node("node-b"), &s);
        assert_eq!(st, Status::Err);
        let p = problem(node("node-b"), st, &s).unwrap();
        assert_eq!((p.reason.as_str(), p.message.as_deref()), ("NotReady", Some("Kubelet stopped posting node status.")));
        let (st, badges) = describe(node("node-c"), &s);
        assert_eq!(st, Status::Warn);
        assert!(badges.contains(&"MemoryPressure".to_string()));
        assert_eq!(problem(node("node-c"), st, &s).unwrap().reason, "MemoryPressure");
    }

    #[test]
    fn pods_picked_by_a_policy_carry_a_policy_badge() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let (_, badges) = describe(s.find(Kind::Pod, Some("s"), "web-1").unwrap(), &s);
        assert!(badges.contains(&"policy".to_string()), "{badges:?}");
        let (_, badges) = describe(s.find(Kind::Pod, Some("t"), "other-1").unwrap(), &s);
        assert!(!badges.contains(&"policy".to_string()), "admitted is not selected");
    }

    #[test]
    fn overview_explains_policies_roles_and_bindings() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let rows = |k: Kind, ns: Option<&str>, n: &str| summary(s.find(k, ns, n).unwrap());
        let get = |r: &SummaryRows, key: &str| r.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).unwrap_or_default();
        let np = rows(Kind::NetworkPolicy, Some("s"), "web-ingress");
        assert_eq!(get(&np, "Pod selector"), "app=web");
        assert_eq!(
            get(&np, "Ingress 1"),
            "from pods app=client; pods app=client in namespaces kubernetes.io/metadata.name=t; 10.0.0.0/8 on TCP 80"
        );
        assert_eq!(get(&rows(Kind::NetworkPolicy, Some("s"), "deny-all"), "Ingress"), "Default deny");
        let role = rows(Kind::Role, Some("s"), "reader");
        assert_eq!(get(&role, "Rule 1"), "get, list pods, services");
        assert_eq!(get(&role, "Rule 2"), "* deployments.apps");
        assert_eq!(get(&rows(Kind::ClusterRole, None, "unused"), "Rule 1"), "get /healthz");
        let rb = rows(Kind::RoleBinding, Some("s"), "web-reader");
        assert_eq!(get(&rb, "Role"), "Role/reader");
        assert_eq!(get(&rb, "Subjects"), "ServiceAccount s/web, User alice");
        let node = rows(Kind::Node, None, "node-a");
        assert_eq!(get(&node, "Status"), "Ready");
        assert_eq!(get(&node, "Kubelet"), "v1.36.1");
    }
```

(`strs` already exists in these tests; if not, use `vec!["Ready".to_string(), "v1.36.1".to_string()]`.) In `build.rs` tests:

```rust
    #[test]
    fn a_pending_pod_on_a_not_ready_node_points_at_the_node() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let g = build(&s, &BuildOptions::default());
        let p = g.node("Pod/s/client-1").and_then(|n| n.problem.as_ref()).unwrap();
        assert_eq!(p.cause.as_deref(), Some("Node//node-b"));
        assert!(g.node("Pod/t/other-1").and_then(|n| n.problem.as_ref()).is_none(), "a healthy node causes nothing");
    }
```

Run `cargo test --lib graph::` → failures (no Node status, badge, summaries, cause).

- [ ] **Step 2: Node describe/problem** — `status.rs`:

```rust
/// Conditions that make a Ready node yellow.
const NODE_PRESSURE: [&str; 4] = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"];

fn node_conditions(n: &k8s_openapi::api::core::v1::Node) -> &[k8s_openapi::api::core::v1::NodeCondition] {
    n.status.as_ref().and_then(|s| s.conditions.as_deref()).unwrap_or_default()
}

fn node_pressure(n: &k8s_openapi::api::core::v1::Node) -> Option<&k8s_openapi::api::core::v1::NodeCondition> {
    node_conditions(n).iter().find(|c| NODE_PRESSURE.contains(&c.type_.as_str()) && c.status == "True")
}

/// Not ready → err; a pressure condition → warn. A node without a Ready condition (hand-written
/// fixtures) counts as ok.
fn node(n: &k8s_openapi::api::core::v1::Node) -> (Status, Badges) {
    let not_ready = node_conditions(n).iter().any(|c| c.type_ == "Ready" && c.status != "True");
    let mut badges = vec![crate::graph::rows::node_ready_text(n)];
    if let Some(v) = n.status.as_ref().and_then(|s| s.node_info.as_ref()) {
        badges.push(v.kubelet_version.clone());
    }
    let pressure = node_pressure(n);
    if let Some(c) = pressure {
        badges.push(c.type_.clone());
    }
    let status = if not_ready { Status::Err } else if pressure.is_some() { Status::Warn } else { Status::Ok };
    (status, badges)
}
```

  - `base_describe`: split the placeholder — `Object::Node(n) => node(n),` and keep the others as `(Status::Ok, vec![])`.
  - `problem`: before `_ => return None`:
    ```rust
        Object::Node(n) => match node_conditions(n).iter().find(|c| c.type_ == "Ready" && c.status != "True") {
            Some(c) => own("NotReady", c.message.clone()),
            None => match node_pressure(n) {
                Some(c) => own(c.type_.clone(), c.message.clone()),
                None => return None,
            },
        },
    ```

- [ ] **Step 3: Policy badge** — in `describe_with`, after `base_describe`:

```rust
    if matches!(obj, Object::Pod(_)) && picked_by_a_policy(obj, store) {
        badges.push("policy".into());
    }
```

with

```rust
/// Whether a NetworkPolicy in the pod's namespace selects it (so its traffic is restricted).
fn picked_by_a_policy(pod: &Object, store: &Store) -> bool {
    store.iter_kind(Kind::NetworkPolicy).any(|np| {
        let Object::NetworkPolicy(np) = np else { return false };
        np.metadata.namespace.as_deref() == pod.namespace()
            && np.spec.as_ref().is_some_and(|s| crate::graph::selector::label_selector_matches(&s.pod_selector, pod.meta().labels.as_ref()))
    })
}
```

(The badge goes after the phase badge, so `badges[0]` stays the phase for existing consumers.)

- [ ] **Step 4: Summaries** — in `summary`, before `_ => {}`:

```rust
        Object::NetworkPolicy(np) => {
            if let Some(spec) = np.spec.as_ref() {
                rows.push(("Pod selector".into(), crate::graph::selector::selector_text(&spec.pod_selector)));
                let types = spec.policy_types.clone().unwrap_or_else(|| vec!["Ingress".into()]);
                rows.push(("Policy types".into(), types.join(", ")));
                let ingress = spec.ingress.as_deref().unwrap_or_default();
                if types.iter().any(|t| t == "Ingress") && ingress.is_empty() {
                    rows.push(("Ingress".into(), "Default deny".into()));
                }
                for (i, r) in ingress.iter().enumerate() {
                    rows.push((format!("Ingress {}", i + 1), rule_text("from", r.from.as_deref(), r.ports.as_deref())));
                }
                let egress = spec.egress.as_deref().unwrap_or_default();
                if types.iter().any(|t| t == "Egress") && egress.is_empty() {
                    rows.push(("Egress".into(), "Default deny".into()));
                }
                for (i, r) in egress.iter().enumerate() {
                    rows.push((format!("Egress {}", i + 1), rule_text("to", r.to.as_deref(), r.ports.as_deref())));
                }
            }
        }
        Object::Role(r) => push_rules(&mut rows, r.rules.as_deref().unwrap_or_default()),
        Object::ClusterRole(r) => push_rules(&mut rows, r.rules.as_deref().unwrap_or_default()),
        Object::RoleBinding(b) => {
            rows.push(("Role".into(), format!("{}/{}", b.role_ref.kind, b.role_ref.name)));
            rows.push(("Subjects".into(), crate::graph::rows::subjects_text(b.subjects.as_deref().unwrap_or_default())));
        }
        Object::ClusterRoleBinding(b) => {
            rows.push(("Role".into(), format!("{}/{}", b.role_ref.kind, b.role_ref.name)));
            rows.push(("Subjects".into(), crate::graph::rows::subjects_text(b.subjects.as_deref().unwrap_or_default())));
        }
        Object::Node(n) => {
            rows.push(("Status".into(), crate::graph::rows::node_ready_text(n)));
            rows.push(("Roles".into(), crate::graph::rows::node_roles(n)));
            if let Some(i) = n.status.as_ref().and_then(|s| s.node_info.as_ref()) {
                rows.push(("Kubelet".into(), i.kubelet_version.clone()));
                rows.push(("OS".into(), i.os_image.clone()));
            }
            for c in node_conditions(n).iter().filter(|c| c.type_ != "Ready" && c.status == "True") {
                rows.push((format!("Condition {}", c.type_), c.message.clone().unwrap_or_default()));
            }
        }
```

with helpers

```rust
/// `from pods app=client; pods app=client in namespaces …; 10.0.0.0/8 on TCP 80`.
fn rule_text(dir: &str, peers: Option<&[k8s_openapi::api::networking::v1::NetworkPolicyPeer]>, ports: Option<&[k8s_openapi::api::networking::v1::NetworkPolicyPort]>) -> String {
    use crate::graph::selector::selector_text;
    let peers = match peers {
        None | Some([]) => "anywhere".to_string(),
        Some(ps) => ps
            .iter()
            .map(|p| match (&p.pod_selector, &p.namespace_selector, &p.ip_block) {
                (_, _, Some(b)) => match b.except.as_deref() {
                    Some(ex) if !ex.is_empty() => format!("{} except {}", b.cidr, ex.join(", ")),
                    _ => b.cidr.clone(),
                },
                (Some(pod), None, None) => format!("pods {}", selector_text(pod)),
                (None, Some(ns), None) => format!("namespaces {}", selector_text(ns)),
                (Some(pod), Some(ns), None) => format!("pods {} in namespaces {}", selector_text(pod), selector_text(ns)),
                (None, None, None) => "anywhere".to_string(),
            })
            .collect::<Vec<_>>()
            .join("; "),
    };
    let ports = match ports {
        None | Some([]) => "all ports".to_string(),
        Some(ps) => ps
            .iter()
            .map(|p| {
                let proto = p.protocol.clone().unwrap_or_else(|| "TCP".into());
                match &p.port {
                    Some(k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(n)) => format!("{proto} {n}"),
                    Some(k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s)) => format!("{proto} {s}"),
                    None => proto,
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
    };
    format!("{dir} {peers} on {ports}")
}

/// `Rule N`: `get, list pods, services` / `* deployments.apps` / `get /healthz`.
fn push_rules(rows: &mut SummaryRows, rules: &[k8s_openapi::api::rbac::v1::PolicyRule]) {
    for (i, r) in rules.iter().enumerate() {
        let verbs = r.verbs.join(", ");
        let targets = if let Some(urls) = r.non_resource_urls.as_ref().filter(|u| !u.is_empty()) {
            urls.join(", ")
        } else {
            let groups = r.api_groups.as_deref().unwrap_or_default();
            r.resources
                .iter()
                .flatten()
                .flat_map(|res| {
                    groups.iter().map(move |g| if g.is_empty() { res.clone() } else { format!("{res}.{g}") })
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        rows.push((format!("Rule {}", i + 1), format!("{verbs} {targets}")));
    }
}
```

> The expected `Ingress 1` text in the test has no extra "from" before later peers: `rule_text` joins peers with `; ` after one leading `from`. A rule with `apiGroups: [""]` and several resources must read `get, list pods, services` (the empty group adds no suffix).

- [ ] **Step 5: Pod → node cause** — `build.rs` `link_causes`: add `Kind::Pod => Relation::RunsOn,` to the relation match, and restrict pods to the waiting reasons with an err node:

```rust
            let relation = match n.kind {
                Kind::Deployment | Kind::StatefulSet | Kind::DaemonSet | Kind::ReplicaSet | Kind::Job | Kind::CronJob => Relation::Owns,
                Kind::Service => Relation::Selects,
                // A pod that is stuck because its node is down: the node is the cause.
                Kind::Pod if n.problem.as_ref().is_some_and(|p| matches!(p.reason.as_str(), "Pending" | "Unknown")) => Relation::RunsOn,
                _ => return None,
            };
            outgoing
                .get(&(n.id.as_str(), relation))?
                .iter()
                .filter_map(|t| nodes.get(*t))
                .filter(|t| if relation == Relation::RunsOn { t.status == Status::Err } else { t.status >= Status::Warn })
                …
```

- [ ] **Step 6: Run** — `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. The invariant test now also checks node-b (Err, NotReady) and node-c (Warn, MemoryPressure). Expected: all pass.
- [ ] **Step 7: Commit** — "Show node health, policy badges, node causes and RBAC/policy rules" + trailers.

---

### Task 6: IPC contract and fixtures

**Files:** Create `src/shared/ipc/fixtures/graph_extras.json`; modify `src-tauri/tests/ipc_fixtures.rs`, `docs/ipc-contract.md`

- [ ] **Step 1: Fixture** `src/shared/ipc/fixtures/graph_extras.json`:

```json
{
  "nodes": [
    { "id": "NetworkPolicy/s/web-ingress", "kind": "NetworkPolicy", "namespace": "s", "name": "web-ingress", "status": "ok", "badges": [], "group": null },
    { "id": "Pod/s/web-1", "kind": "Pod", "namespace": "s", "name": "web-1", "status": "ok", "badges": ["Running", "policy"], "group": null },
    { "id": "Node//node-a", "kind": "Node", "namespace": null, "name": "node-a", "status": "ok", "badges": ["Ready", "v1.36.1"], "group": null },
    { "id": "RoleBinding/s/web-reader", "kind": "RoleBinding", "namespace": "s", "name": "web-reader", "status": "ok", "badges": [], "group": null },
    { "id": "Role/s/reader", "kind": "Role", "namespace": "s", "name": "reader", "status": "ok", "badges": [], "group": null },
    { "id": "ServiceAccount/s/web", "kind": "ServiceAccount", "namespace": "s", "name": "web", "status": "ok", "badges": [], "group": null }
  ],
  "edges": [
    { "id": "NetworkPolicy/s/web-ingress->Pod/s/web-1:applies", "source": "NetworkPolicy/s/web-ingress", "target": "Pod/s/web-1", "relation": "applies" },
    { "id": "Pod/s/web-1->NetworkPolicy/s/web-ingress:allows", "source": "Pod/s/web-1", "target": "NetworkPolicy/s/web-ingress", "relation": "allows" },
    { "id": "RoleBinding/s/web-reader->Role/s/reader:grants", "source": "RoleBinding/s/web-reader", "target": "Role/s/reader", "relation": "grants" },
    { "id": "RoleBinding/s/web-reader->ServiceAccount/s/web:subject", "source": "RoleBinding/s/web-reader", "target": "ServiceAccount/s/web", "relation": "subject" },
    { "id": "Pod/s/web-1->Node//node-a:runsOn", "source": "Pod/s/web-1", "target": "Node//node-a", "relation": "runsOn" }
  ]
}
```

(Match the exact `Graph` JSON shape of the existing `graph.json` fixture — copy its optional fields, e.g. `tooLarge`, if the round-trip test requires them.)

- [ ] **Step 2: Failing test** — in `ipc_fixtures.rs`, following the existing `graph` fixture test:

```rust
#[test]
fn graph_with_policies_rbac_and_nodes() {
    let g: Graph = serde_json::from_str(&fixture("graph_extras.json")).unwrap();
    let kinds: Vec<_> = g.nodes.iter().map(|n| n.kind.as_str()).collect();
    for k in ["NetworkPolicy", "Node", "RoleBinding", "Role"] {
        assert!(kinds.contains(&k), "{k}");
    }
    let rels: Vec<_> = g.edges.iter().map(|e| e.relation.as_str()).collect();
    assert_eq!(rels, ["applies", "allows", "grants", "subject", "runsOn"]);
    assert_eq!(serde_json::to_value(&g).unwrap()["edges"][4]["relation"], "runsOn");
}
```

(Use the file's existing `fixture(name)` reader and imports.) Run `cd src-tauri && cargo test --test ipc_fixtures` before creating the JSON → fails (missing file); with it → passes.

- [ ] **Step 3: Contract doc** — `docs/ipc-contract.md`: extend the `Kind` row with `NetworkPolicy`, `Role`, `RoleBinding`, `ClusterRole`, `ClusterRoleBinding`, `Node` (noting the last three are cluster-scoped: ids `Kind//name`), the `Relation` row with `applies`, `allows`, `grants`, `subject`, `runsOn`, and add a short "Policies, RBAC and Nodes" paragraph: which edge goes which way, that cluster-scoped RBAC/Nodes only appear when connected to the scope, the `policy` pod badge, Node statuses, and that `namespaceSelector` peers are matched on `kubernetes.io/metadata.name` only. Add `graph_extras.json` to the Fixtures line.

- [ ] **Step 4: Run** `cargo test` → pass. **Commit** "Document policies, RBAC and node edges in the IPC contract" + trailers.

---

### Task 7: Smoke test

**Files:** Modify `src-tauri/tests/fixtures/smoke.yaml`, `src-tauri/tests/smoke.rs`

- [ ] **Step 1: Fixture** — append to `smoke.yaml` (namespace `wiring-smoke` only):

```yaml
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: web-from-talker, namespace: wiring-smoke }
spec:
  podSelector: { matchLabels: { app: web } }
  policyTypes: [ Ingress ]
  ingress: [ { from: [ { podSelector: { matchLabels: { app: talker } } } ], ports: [ { protocol: TCP, port: 80 } ] } ]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: pod-reader, namespace: wiring-smoke }
rules: [ { apiGroups: [ "" ], resources: [ pods ], verbs: [ get, list ] } ]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: default-reads-pods, namespace: wiring-smoke }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: pod-reader }
subjects: [ { kind: ServiceAccount, name: default, namespace: wiring-smoke } ]
```

(The NetworkPolicy has no effect on docker-desktop's default CNI; it only has to exist.)

- [ ] **Step 2: Smoke step** — in `smoke.rs`, add after the `phases.done("graph");` block (before details), reusing `graph_until`:

```rust
    // Policies, RBAC and the node this runs on are wired up.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let ok = graph_until(&mut rx, &mut graph, deadline, |g| {
        let edge = |rel: &str, src: &str| g.edges.iter().any(|e| e.relation.as_str() == rel && e.source.starts_with(src));
        edge("applies", "NetworkPolicy/wiring-smoke/web-from-talker")
            && edge("allows", "Pod/wiring-smoke/talker")
            && edge("grants", "RoleBinding/wiring-smoke/default-reads-pods")
            && edge("subject", "RoleBinding/wiring-smoke/default-reads-pods")
            && g.edges.iter().any(|e| e.relation.as_str() == "runsOn" && e.target.starts_with("Node//"))
            && g.nodes.iter().any(|n| n.kind == Kind::Node && n.status == Status::Ok)
    })
    .await;
    assert!(ok, "policy / RBAC / node edges never appeared; last graph: {graph:#?}");
    phases.done("graph extras");
```

(`Kind`/`Status` imports: add `wiring_lib::store::Kind` and `wiring_lib::graph::model::Status` if not imported. `talker`'s pods sit in a PodGroup only above 5 replicas — it has 1, so the `allows` source is `Pod/wiring-smoke/talker-…`.)

- [ ] **Step 3: Run** — `cd src-tauri && WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored --nocapture 2>&1 | tee <scratch log>` (docker-desktop only; it deletes/recreates only `wiring-smoke` and `wiring-smoke-b`). Expected: pass, with a `phase graph extras` line. Run twice.
- [ ] **Step 4: Commit** — "Smoke-test policy, RBAC and node edges" + trailers.

---

### Task 8: Frontend kinds, relations, metadata, layout, templates

**Files:** Modify `src/shared/ipc/types.ts`, `src/shared/ipc/fixtures.test.ts`, `src/features/graph/kindMeta.ts`, `src/features/graph/layout.ts`, `src/features/navigator/kindTree.ts`, `src/features/editor/templates.ts` (+ `templates.test.ts`)

All `Record<Kind, …>` maps must gain the six kinds in the same commit, or `pnpm typecheck` fails.

- [ ] **Step 1: Failing tests**
  - `fixtures.test.ts`: `it("accepts a graph with policies, RBAC and nodes", () => { expect(isGraph(graphExtras)).toBe(true); })` importing `./fixtures/graph_extras.json` (use the guard the existing graph fixture test uses).
  - `templates.test.ts`: `for (const kind of ["NetworkPolicy", "Role", "RoleBinding"] as const) expect(template(kind, "shop")).toMatch(new RegExp(`kind: ${kind}\\n[\\s\\S]*namespace: shop`));` and `expect(CREATABLE_KINDS).not.toContain("Node"); expect(CREATABLE_KINDS).not.toContain("ClusterRole");`.
  Run `pnpm test` → fail.

- [ ] **Step 2: types.ts**
  ```ts
  export const KINDS = [
    "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod", "Service", "Ingress",
    "ConfigMap", "Secret", "PersistentVolumeClaim", "PersistentVolume", "ServiceAccount", "HorizontalPodAutoscaler",
    "NetworkPolicy", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "Node",
    "PodGroup",
  ] as const;
  export const RELATIONS = ["owns", "selects", "routes", "mounts", "envFrom", "claims", "binds", "usesSA", "scales", "applies", "allows", "grants", "subject", "runsOn"] as const;
  ```

- [ ] **Step 3: kindMeta.ts** — add to `KIND_META`:
  ```ts
  NetworkPolicy: { label: "NetworkPolicy", letter: "NP", short: "NetPol" },
  Role: { label: "Role", letter: "R", short: "Role" },
  RoleBinding: { label: "RoleBinding", letter: "RB", short: "RoleBinding" },
  ClusterRole: { label: "ClusterRole", letter: "CR", short: "ClusterRole" },
  ClusterRoleBinding: { label: "ClusterRoleBinding", letter: "CRB", short: "CRB" },
  Node: { label: "Node", letter: "N", short: "Node" },
  ```
  and append the six to `CHIP_KINDS` after `"HorizontalPodAutoscaler"`.

- [ ] **Step 4: layout.ts** `LAYERS`: `RoleBinding: 3, ClusterRoleBinding: 3, Role: 4, ClusterRole: 4, NetworkPolicy: 5, Node: 7,` (bindings left of roles and SAs; policies left of pods; nodes right of pods, so `applies`, `grants`, `subject` and `runsOn` are forward edges).

- [ ] **Step 5: kindTree.ts** `KIND_PLURAL`: `NetworkPolicy: "Network Policies", Role: "Roles", RoleBinding: "Role Bindings", ClusterRole: "Cluster Roles", ClusterRoleBinding: "Cluster Role Bindings", Node: "Nodes",` (sections come in Task 11).

- [ ] **Step 6: templates.ts**
  ```ts
  /** Kinds the Create dialog offers: every watched kind but the synthetic PodGroup and the cluster-level RBAC objects and Nodes. */
  export type CreatableKind = Exclude<Kind, "PodGroup" | "ClusterRole" | "ClusterRoleBinding" | "Node">;
  const NOT_CREATABLE = new Set<Kind>(["PodGroup", "ClusterRole", "ClusterRoleBinding", "Node"]);
  export const CREATABLE_KINDS: CreatableKind[] = KINDS.filter((k): k is CreatableKind => !NOT_CREATABLE.has(k));
  ```
  and `BODIES`:
  ```ts
  NetworkPolicy: {
    apiVersion: "networking.k8s.io/v1", name: "my-networkpolicy",
    body: "spec:\n  podSelector:\n    matchLabels:\n      app: my-app\n  policyTypes:\n    - Ingress\n  ingress:\n    - from:\n        - podSelector:\n            matchLabels:\n              app: my-client\n",
  },
  Role: {
    apiVersion: "rbac.authorization.k8s.io/v1", name: "my-role",
    body: "rules:\n  - apiGroups: [\"\"]\n    resources: [\"pods\"]\n    verbs: [\"get\", \"list\"]\n",
  },
  RoleBinding: {
    apiVersion: "rbac.authorization.k8s.io/v1", name: "my-rolebinding",
    body: "roleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n  name: my-role\nsubjects:\n  - kind: ServiceAccount\n    name: default\n",
  },
  ```

- [ ] **Step 7: Run** — `pnpm typecheck && pnpm test` (exit code 0, no unhandled errors). Fix any other `Record<Kind,…>`/switch the typecheck reports by adding the six kinds.
- [ ] **Step 8: Commit** — "Know NetworkPolicies, RBAC objects and Nodes in the frontend" + trailers.

---

### Task 9: Edge styles

**Files:** Modify `src/features/graph/RelationEdge.tsx` (+ `RelationEdge.test.tsx`)

- [ ] **Step 1: Failing test** — render a `RelationEdge` per relation (as the existing test does) and assert the path's `stroke-dasharray`: `owns` → none, `runsOn` → `"2 4"`, `allows` → `"8 3 2 3"`, others (e.g. `applies`) → `"6 4"`.
- [ ] **Step 2: Implement** — replace the `solid` logic with

```ts
/** Ownership is solid; a pod's node dotted; a policy's admitted peers dash-dot; everything else dashed. */
function dashFor(relation: Relation | undefined): string | undefined {
  switch (relation) {
    case "owns": return undefined;
    case "runsOn": return "2 4";
    case "allows": return "8 3 2 3";
    default: return "6 4";
  }
}
```

and `strokeDasharray: dashFor(data?.edge.relation)` (import `type Relation` from `../../shared/ipc/types`).
- [ ] **Step 3: Run** `pnpm typecheck && pnpm test`. **Commit** "Give node and policy edges their own dash" + trailers.

---

### Task 10: Chips — RBAC and Nodes start hidden

**Files:** Modify `src/app/store.ts` (+ `store.test.ts`)

- [ ] **Step 1: Failing test** — `expect([...initialState().hiddenKinds].sort()).toEqual(["ClusterRole", "ClusterRoleBinding", "Node", "Role", "RoleBinding"]);` and that toggling `Node` shows it (existing toggle test pattern).
- [ ] **Step 2: Implement** — in `store.ts`:

```ts
/** Kinds whose chips start off: RBAC objects and Nodes would crowd most graphs. */
export const DEFAULT_HIDDEN_KINDS: readonly Kind[] = ["Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "Node"];
```

and `hiddenKinds: new Set(DEFAULT_HIDDEN_KINDS),` in `initialState()`. The chip state already survives reconnects (the reset keeps `s.hiddenKinds`). Update existing tests that assumed an empty initial set (e.g. by asserting relative to `DEFAULT_HIDDEN_KINDS`).
- [ ] **Step 3: Run** `pnpm typecheck && pnpm test`. **Commit** "Start with RBAC and Node chips off" + trailers.

---

### Task 11: Navigator sections

**Files:** Modify `src/features/navigator/kindTree.ts`, `src/features/navigator/sectionIcons.ts` (+ `kindTree.test.ts` / `Navigator.test.tsx`)

- [ ] **Step 1: Failing test** — `kindTree.test.ts`: `expect(sectionOf("NetworkPolicy")?.id).toBe("network"); expect(sectionOf("ClusterRoleBinding")?.id).toBe("access"); expect(sectionOf("Node")?.id).toBe("cluster"); expect(SECTIONS.at(-1)?.label).toBe("Cluster");`
- [ ] **Step 2: Implement** — `SECTIONS`:

```ts
  { id: "network", label: "Network", kinds: ["Service", "Ingress", "NetworkPolicy"] },
  { id: "storage", label: "Storage", kinds: ["PersistentVolumeClaim", "PersistentVolume"] },
  { id: "access", label: "Access Control", kinds: ["ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"] },
  { id: "cluster", label: "Cluster", kinds: ["Node"] },
```

and `sectionIcons.ts`: import `Server` from `lucide-react` and add `cluster: Server`.
- [ ] **Step 3: Run** `pnpm typecheck && pnpm test`. **Commit** "List policies, RBAC and Nodes in the navigator" + trailers.

---

### Task 12: README

- [ ] Add to the **Graph.** bullets in `README.md`:
  `- NetworkPolicies show which pods they apply to and which pods they let in. Turn on the RBAC chips to see which Roles a ServiceAccount gets through which bindings, and the Node chip to see where each pod runs. A NotReady node is the cause of the pods stuck on it.`
  and mention the new navigator entries in the **Navigator.** paragraph (Network Policies; Roles and bindings under Access Control; a Cluster section with Nodes). Commit "Document policies, RBAC and nodes in the README" + trailers.

---

### Task 13: Full checks

- [ ] `pnpm typecheck && pnpm test` — exit code 0, no "Unhandled Errors" section.
- [ ] `pnpm build`
- [ ] `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- [ ] `WIRING_SMOKE_CONTEXT=docker-desktop rtk proxy cargo test --test smoke -- --ignored --nocapture 2>&1 | tee <scratch log>` — twice, docker-desktop only.

---

## Self-review

- Spec §3 kinds/tables/navigator/chips/templates → Tasks 2, 8, 10, 11; edges → Task 3; cluster-scoped visibility → Task 4; Node status, policy badge, node causes, rule text → Task 5; RBAC denials need nothing new (existing denied-kinds path, struck-through chips/navigator rows); contract → Task 6; smoke → Task 7; README → Task 12.
- Every new `Object` variant is handled in `for_each_object!`, `kind()`, `from_json_value`, `api_resource`, `into_object!`, `spawn_stream`, `base_describe`, `columns`, `kind_cells`; `problem`/`summary` have default arms.
- Names are consistent: `label_selector_matches`, `selector_text`, `network_policy_edges`, `rbac_edges`, `node_edges`, `retain_connected_cluster_objects`, `subjects_text`, `node_ready_text`, `node_roles`, `DEFAULT_HIDDEN_KINDS`, relations `applies/allows/grants/subject/runsOn`.

## Deviations from the spec

1. **namespaceSelector** peers are matched only on the `kubernetes.io/metadata.name` label (Namespaces are not watched); other namespace labels match nothing, but the rule text still lists them.
2. **Egress** gets rule text in Overview but no graph edges (the spec's `allows` covers ingress only).
3. **Pod → node causes** only for pods whose own problem is `Pending` or `Unknown` and whose node is red, so a crash-looping pod on a flaky node keeps its own root cause.
4. **Chip state** is remembered for the session (across reconnects), as today — it is not persisted to settings.
5. **Create templates** only for NetworkPolicy, Role, RoleBinding; ClusterRole, ClusterRoleBinding and Node are not offered in Create (YAML editing still works).
6. **Node table** shows Pods counted from the current scope's pods, not all pods on the node.
7. Frontend metadata, layers and templates land in one task (Task 8), because every `Record<Kind, …>` must include the new kinds for typecheck to pass.
