# Wiring — NetworkPolicies, RBAC and Nodes on the graph

**Date:** 2026-10-06
**Status:** approved
**Builds on:** multi-namespace (branch `feat/multi-namespace`).

## 1. Goal

Show three more kinds of wiring: which **NetworkPolicies** apply to which pods, which **Roles** a ServiceAccount gets through which **RoleBindings**, and which **Node** each pod runs on — so "why can't A reach B", "what can this SA do" and "everything on the broken node" are answered from the graph.

## 2. Non-goals

Simulating traffic or evaluating whether a connection is allowed, effective-permission calculation (`kubectl auth can-i`), editing RBAC through special UI (YAML editing works as for any kind), node actions (cordon/drain), node metrics, CiliumNetworkPolicy / other CRD policies, User/Group subjects as nodes.

## 3. User flows

- **Kinds.** New watched kinds: `NetworkPolicy`, `Role`, `RoleBinding` (namespaced) and `ClusterRole`, `ClusterRoleBinding`, `Node` (cluster-scoped). They get tables, navigator entries (Network → *Network Policies*; Access Control → *Roles*, *Role Bindings*, *Cluster Roles*, *Cluster Role Bindings*; a new **Cluster** category → *Nodes*), kind chips and Create templates for the namespaced ones.
- **Graph defaults.** To keep graphs readable, the NetworkPolicy chip is on by default; RBAC (`Role`, `RoleBinding`, `ClusterRole`, `ClusterRoleBinding`) and `Node` chips are off by default. Chip state is remembered as today.
- **NetworkPolicy edges.** `applies`: policy → every pod/pod group matched by `spec.podSelector` in its namespace. `allows`: pod/pod group → policy for pods in the scope matched by an ingress `from.podSelector` (same namespace, or namespaces matched by `namespaceSelector` among the scope). Overview of a policy lists its rules as text (`Ingress from app=web on TCP 80`, `Egress to 10.0.0.0/8`, `Default deny ingress`). A pod selected by any policy shows a small `policy` badge.
- **RBAC edges.** `grants`: RoleBinding/ClusterRoleBinding → the Role/ClusterRole in `roleRef`. `subject`: binding → ServiceAccount subjects that are in the scope. Only ClusterRoles/ClusterRoleBindings connected to something in the scope are shown on the graph (the tables list them all). Overview of a Role/ClusterRole lists its rules (`get, list pods`, `* deployments.apps`), of a binding its subjects (including Users/Groups as text).
- **Node edges.** `runsOn`: pod/pod group → Node (`spec.nodeName`). Only Nodes hosting a pod in the scope appear on the graph. Node status: `Ready` → ok; `MemoryPressure` / `DiskPressure` / `PIDPressure` / `NetworkUnavailable` true → warn; `Ready=False/Unknown` → err, with a problem (`NotReady — <condition message>`). A pod that is Unknown/Pending because its node is NotReady gets the node as its problem `cause`.
- **RBAC denials.** Kinds the user can't watch (cluster-scoped RBAC and Nodes often are) are struck through as today; nothing else breaks.

## 4. Backend

- `store::Kind` gains the six kinds, `WATCHED` grows, `is_cluster_scoped` covers `ClusterRole`, `ClusterRoleBinding`, `Node`; `api_resource` and table rows (`kubectl get`-style columns: NetworkPolicy *Pod selector, Policy types*; Role/ClusterRole *Rules*; bindings *Role, Subjects*; Node *Status, Roles, Version, Pods, Age*).
- Cluster-scoped watchers run once per connection scope (not per namespace), like PersistentVolumes today.
- `graph::relations`: `network_policy_edges`, `rbac_edges`, `node_edges`; new `Relation` variants `applies`, `allows`, `grants`, `subject`, `runsOn`. Visibility filtering of cluster-scoped RBAC and Nodes to "connected to the scope" happens in `graph::build` after edges are known (as for bound PVs).
- `graph::status`: Node status + problem; the `policy` badge on pods; Overview summaries for the new kinds; problem `cause` pod → node when the node is NotReady.
- Label selector matching (matchLabels and matchExpressions In/NotIn/Exists/DoesNotExist) as a shared pure helper, used by NetworkPolicy and reusable elsewhere.

## 5. Frontend

- Kind metadata (labels, short codes, icons, colours) for the six kinds; navigator categories; kind chips with the defaults above; Create templates for NetworkPolicy, Role, RoleBinding; edge styles for the new relations (dashed for `allows`, dotted for `runsOn`).

## 6. Testing

- **Rust:** selector matching (all operators), each relation on fixtures (policy podSelector + ingress peers incl. namespaceSelector over a multi-namespace scope; RoleBinding → Role / ClusterRole, subjects in/out of scope; pod → node), cluster-scoped visibility filtering, Node status/problem + pod cause, Overview summaries, rows.
- **Smoke (docker-desktop only):** the fixture gains a NetworkPolicy and a Role/RoleBinding for its ServiceAccount; assert the `applies`, `grants`, `subject` and `runsOn` edges and that the docker-desktop Node is Ready.
- **Vitest:** chips defaults, navigator entries, edge styles, Create templates.

## 7. Decisions log

- Six new kinds; NetworkPolicy shown by default, RBAC and Nodes behind chips that start off.
- Policies: `applies` and ingress `allows` edges plus rule text; no traffic evaluation.
- RBAC: binding → role (`grants`), binding → SA (`subject`); cluster-scoped RBAC only when connected to the scope.
- Nodes: only those hosting pods in the scope; NotReady nodes become the cause of their pods' problems.
