# Wiring — Port-forward

**Date:** 2026-10-05
**Status:** approved
**Builds on:** Workload actions and Problem explanation (branch `feat/problem-explain`).

## 1. Goal

Reach a Pod, a Service or a workload from the local machine without a terminal: pick a port, get `localhost:<port>`, open it in the browser. Forwards keep working across pod restarts for Services and workloads, and are managed from one place in the header.

## 2. Non-goals

Binding to anything but `127.0.0.1`, UDP, restoring forwards after an app restart, forwarding several ports in one action, forwards for other kinds, sharing forwards across contexts, traffic stats.

## 3. User flows

- **Start.** **Port-forward…** in the Actions menu (Pod, Service, Deployment, StatefulSet, DaemonSet) opens a dialog:
  - **Remote port**: a list of the target's ports — container ports for a Pod or workload (`name/port/protocol`, TCP only), the Service's ports (`port → targetPort`) for a Service. Preselected: the first one.
  - **Local port**: prefilled with the remote port when it is ≥ 1024 and free, otherwise the first free port from 8080 upward; editable (1024…65535).
  - **Start** → toast *Forwarding localhost:8080 → svc/web:80*; the dialog closes.
- **Manage.** A header indicator `⇄ N` (hidden when N = 0) opens a popover listing every forward: `localhost:8080 → Service web :80`, the pod currently serving it, status (`active`, `no ready pod`, `error: …`), and buttons **Open** (http://localhost:8080 in the default browser), **Copy** (address), **Stop**.
- **Reselect.** For a Service or a workload target, every new local connection goes to a ready pod chosen at that moment, so a restart or rollout is followed automatically; while no pod is ready new connections are refused and the status says `no ready pod`. A Pod target whose pod is gone shows `pod gone` and refuses connections until stopped.
- **Lifetime.** Forwards survive a namespace switch. They stop on context switch, disconnect and app quit.
- **Errors.** Local port in use → the dialog shows *Port 8080 is already in use* and stays open. RBAC without `pods/portforward` → the connection fails and the status shows `error: forbidden (pods/portforward)`.

## 4. Backend

### Dependencies

`kube` gains the `ws` feature (needed for `Api::<Pod>::portforward`); `tauri-plugin-opener` is added for **Open**.

### Model (`src-tauri/src/forward/`)

- `ForwardTarget { kind, namespace, name }` from a node id (Pod, Service, Deployment, StatefulSet, DaemonSet; anything else is `invalid`).
- `resolve(store, target, remote_port) -> Result<(pod_name, pod_port), Unready>` — pure, fixture-tested:
  - Pod: itself, if Running and Ready; the port is used as is.
  - Service: ready pods matching `spec.selector` (same readiness rule as the Service status), smallest name first; `remote_port` is a Service port, mapped to its `targetPort` — a number, or a name resolved against the chosen pod's container ports.
  - Deployment / StatefulSet / DaemonSet: ready pods owned by it (`is_owned_by`), smallest name first.
- `ports(store, target) -> Vec<PortOption { port, label }>` for the dialog (TCP only).

### Session (`forward/session.rs`)

- `ForwardManager` owned by the connection (not the namespace session), so forwards survive `select_namespace` and are dropped with the connection.
- `start(target, remote_port, local_port)`: bind `127.0.0.1:local_port` (bind failure → `conflict` "port N is already in use"); spawn an accept loop. Each accepted TCP connection resolves the pod from the cached store **at that moment** (namespaces other than the selected one: a one-off `list` of pods, since the store only caches the selected namespace), opens `Api::<Pod>::portforward(pod, &[port])`, and copies bytes both ways until either side closes.
- Status per forward: `active` (last connection succeeded or none yet), `noReadyPod`, `podGone`, `error(message)`; updated on each connection attempt and when the store changes.
- `stop(id)` aborts the accept loop and its connections. All forwards stop on disconnect / context switch / app exit.

### Contract

| Command | Args | Returns |
|---|---|---|
| `forward_ports` | `{ nodeId }` | `PortOption[]` |
| `suggest_local_port` | `{ port }` | `number` (the port itself if ≥ 1024 and free, else the first free from 8080) |
| `start_forward` | `{ nodeId, remotePort, localPort }` | `Forward` |
| `stop_forward` | `{ id }` | `null` |
| `list_forwards` | — | `Forward[]` |

Event `forwards_changed: Forward[]` after every start/stop/status change. `Forward = { id, nodeId, targetLabel, remotePort, localPort, pod: string | null, status: "active" | "noReadyPod" | "podGone" | "error", message: string | null }`.

## 5. Frontend

- `src/shared/ipc/`: types, guards, command wrappers, the `forwards_changed` listener.
- Store: `forwards: Forward[]` (seeded with `list_forwards` on connect, replaced by each event), the forward dialog state, `startForward`, `stopForward`.
- `src/features/forward/ForwardDialog.tsx` (remote port select, local port input with validation, Start; inline error on `conflict`), `ForwardsIndicator.tsx` (header button + popover with Open / Copy / Stop; Escape closes it via `useGlobalKeys`).
- Actions menu: **Port-forward…** for the five kinds, before the separator.

## 6. Testing

- **Rust unit:** `resolve` for each kind (ready/unready pods, named and numeric targetPort, owner filter, stable choice), `ports` (TCP only, labels), `suggest_local_port` (free / taken / < 1024).
- **Rust integration:** a forward to an in-process TCP echo server is not possible without a cluster; the manager's accept loop and status transitions are unit-tested with a fake connector trait.
- **Smoke (docker-desktop only):** forward to the fixture's `web` Service, make an HTTP request to `localhost:<port>`, get nginx's response; delete the serving pod, retry until a new connection succeeds through another pod; stop the forward and see the port closed.
- **Vitest:** dialog (prefill, validation, conflict error stays open), indicator (hidden at 0, list, Open/Copy/Stop calls), Actions menu item per kind, store updates from `forwards_changed`.

## 7. Decisions log

- Targets: Pod, Service and workloads (Deployment, StatefulSet, DaemonSet).
- A Service/workload forward follows ready pods automatically; a Pod forward stops serving when its pod is gone.
- Managed from a header indicator with a popover; forwards survive namespace switches, end with the connection, are not restored after restart.
- Local port defaults to the remote one when free (≥ 1024), else the first free from 8080; `127.0.0.1` only.
- One `portforward` call per accepted TCP connection (the kube-rs pattern), which is also what makes pod re-selection automatic.
