# Wiring — CPU and memory metrics

**Date:** 2026-10-05
**Status:** approved
**Builds on:** Workload actions, Problem explanation, Port-forward (branch `feat/port-forward`).

## 1. Goal

Show how much CPU and memory pods and workloads use, next to what they requested and are limited to, so it is obvious who runs hot or is about to be OOM-killed — the `kubectl top` view, inside the tables, Overview and the graph.

## 2. Non-goals

Node metrics, history and charts, custom/Prometheus metrics, alerting, installing metrics-server from the app, changing a node's status colour because of usage.

## 3. User flows

- **Tables.** The Pods table gains **CPU** and **Memory** columns (`120m`, `64Mi`), sortable. Deployments, StatefulSets and DaemonSets gain the same columns with the sum over their pods. Values are `—` until the first sample arrives and when no metrics are available.
- **Overview.** Pods and workloads get a **Usage** row: `CPU 120m / req 100m / lim 500m (24%)` and `Memory 64Mi / req 64Mi / lim 128Mi (50%)`. The percentage is of the limit; without a limit it is of the request; without either it is omitted.
- **Graph.** A pod or workload whose memory or CPU use is at or above 80 % of its limit gets a badge `mem 92%` / `cpu 85%` (the higher of the two, memory first on ties). Nothing else on the graph changes.
- **No metrics-server.** When the Metrics API is not installed the columns and the Usage row show `—`, and the Overview row says *Metrics API not available (install metrics-server)*. When RBAC forbids `pods.metrics.k8s.io` it says *No access to pod metrics (RBAC)*. Nothing else breaks.
- **Demo.** `examples/demo/setup.sh --with-metrics` installs metrics-server (with `--kubelet-insecure-tls`, as local clusters need).

## 4. Backend

### Polling (`src-tauri/src/metrics/`)

- A per-namespace-session poller lists `PodMetrics` (`metrics.k8s.io/v1beta1`, as a `DynamicObject` / `ApiResource`) in the selected namespace every 15 s (metrics-server's resolution) and once right after `select_namespace`. It stops with the namespace session.
- A 404 / "the server could not find the requested resource" marks the API as `unavailable` and stops polling until the next namespace session; a 403 marks it `forbidden` and stops polling the same way; transient errors keep the last sample and retry next tick.
- Samples are parsed into `PodUsage { cpu_millis: u64, memory_bytes: u64 }` (sum of containers) keyed by pod name. Parsing of Kubernetes quantities (`n`, `u`, `m`, plain cores; `Ki`, `Mi`, `Gi`, `k`, `M`, `G`, plain bytes) is a pure, tested function.

### Use in the graph, tables and summary

- The store keeps the latest `MetricsSample { state: available | unavailable | forbidden | pending, pods: HashMap<String, PodUsage> }`.
- `graph::rows` adds CPU and Memory cells for Pod, Deployment, StatefulSet, DaemonSet (workload values sum the pods it owns, the same ownership rule as the graph). Cells sort numerically.
- `graph::status::summary` adds the **Usage** row for those kinds, with requests and limits summed over containers (and over pods for workloads).
- `graph::status::describe` appends the ≥ 80 % badge. Usage never changes a node's status.
- A new sample triggers a graph rebuild like a watch event does; only nodes whose badge changed appear in the `graph_delta`.

### Contract

New event `metrics_updated: { state }` after each sample (and on a state change), so the frontend refetches the open table's rows and the selected object's details. `docs/ipc-contract.md` documents it and the new table columns / summary row.

## 5. Frontend

- Listen to `metrics_updated`: refetch `list_rows` for the visible table and reload the selected details (through the existing throttled details reload).
- Tables already render whatever columns `list_rows` returns; check the numeric sort for the new columns.
- No new components.

## 6. Testing

- **Rust unit:** quantity parsing (every suffix, fractions, garbage → None), sample parsing from a `PodMetrics` fixture, workload sums, percentages (limit, request fallback, none), the 80 % badge threshold and its tie rule, `unavailable` / `forbidden` states from 404 / 403, rows with and without a sample.
- **Smoke (docker-desktop only):** if `metrics.k8s.io` is served, wait for a sample for the fixture's pods and check the Pods table's CPU/Memory cells are non-`—`; otherwise assert the `unavailable` state.
- **Vitest:** `metrics_updated` triggers a rows refetch for the open table and a details reload.

## 7. Decisions log

- Source is metrics-server's Metrics API, polled every 15 s for the selected namespace only.
- Shown in tables (pods and workloads), an Overview Usage row, and a graph badge only at ≥ 80 % of the limit.
- Percentages are of the limit, else the request.
- Missing Metrics API or RBAC degrade to `—` with a one-line explanation; nothing is installed by the app.
- `setup.sh --with-metrics` installs metrics-server for the demo.
