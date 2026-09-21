# Wiring — Pod logs

**Date:** 2026-09-21
**Status:** approved
**Builds on:** MVP, Navigator/tables and YAML editing (all merged).

## 1. Goal

A **Logs** tab in the details panel that streams container logs live — for a single Pod and, merged, for every pod of a workload — with the controls Lens users reach for first: container picker, previous run, timestamps, search, wrap, clear, download, ANSI colours. Because the details panel is short, it becomes resizable and can be maximised over the centre pane.

## 2. Non-goals

Level/regex filters, `since` windows, a separate logs window, node or control-plane logs, keeping the buffer across selections, multiple simultaneous log tabs.

## 3. User flows

- Select a Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob or PodGroup → the **Logs** tab appears next to Overview · YAML · Events. Opening it starts streaming: the last 500 lines per container, then follow. Switching object or tab, changing namespace or disconnecting stops the stream and clears the buffer.
- Toolbar: **Container** (All / each container; init containers marked `init`), **Previous** (last terminated run, no follow), **Timestamps**, **Wrap** toggles; search box with `n / N` match counter, ↑ ↓ / Enter to step through matches, matches highlighted; **Clear**; **Download** (save dialog → `.log`); status on the right: `● streaming · 3 pods`, `ended`, `truncated to 64 streams`.
- Output: monospace, virtualised, one line per log line. With more than one stream each line is prefixed `[pod/container]` in a colour hashed from the pod name; timestamps in muted grey; ANSI SGR colours rendered with the theme palette. Auto-scroll sticks to the bottom; scrolling up unsticks; a **↓ Follow** button re-sticks.
- Stream problems (container waiting to start, 403, ended) are lines inside the output — `api-8555cf87cc-f65gv/api — container "api" is waiting to start: ImagePullBackOff` — never toasts.
- Workloads: pods that appear while streaming (rollout, PodGroup recreation) are added; deleted pods end their streams. At most 64 concurrent streams; beyond that the status says `truncated`.
- Details panel: the border between centre and panel is draggable (mouse + ↑/↓ keys on the separator), 200 px … window − 200 px, persisted as `detailsHeight`. A ⤢ button in the panel header maximises it over the centre (graph/table hidden); ⤢ again or Esc restores; clearing the selection restores too.

## 4. Backend

### Targets

`logs::targets(store, node_id) -> Result<Vec<LogTarget { pod: ObjectKey, container: String, init: bool }>, AppError>`, pure and fixture-tested:
- `Pod` → its `spec.initContainers` (init = true) + `spec.containers`.
- `Deployment | StatefulSet | DaemonSet | Job | CronJob | PodGroup` → every pod whose owner chain reaches the object (CronJob → Job → Pod), same rule as the graph's `owns` edges / `group_members`.
- Other kinds → `invalid`.
- `container: Some(name)` keeps only targets with that container name.

### Session

```
start_logs({ nodeId, container: string | null, previous: bool, timestamps: bool }, onBatch: Channel<LogMessage>) -> sessionId (u32)
stop_logs({ sessionId })
```
`Session` holds `HashMap<u32, LogSession>`. A `LogSession` runs one supervised task per `(pod, container)`: `Api<Pod>::log_stream(pod, LogParams { container, follow: !previous, previous, timestamps, tail_lines: Some(500) })`, reads lines, and flushes to the channel every 50 ms or 256 lines, whichever first. Messages (tagged union `LogMessage`):

| `type` | fields | when |
|---|---|---|
| `lines` | `sessionId, lines: [{ pod, container, text }]` | a flushed batch (`text` includes the server timestamp prefix when requested) |
| `started` | `sessionId, pod, container` | the stream connected |
| `ended` | `sessionId, pod, container` | the server closed the stream (container terminated, or `previous` fetch done) |
| `error` | `sessionId, pod, container, message` | 400 (waiting to start), 403, network — the stream is dropped; message is the server's |
| `truncated` | `sessionId, limit` | more than 64 targets; the rest are not streamed |

For workload targets the session subscribes to the reducer's `StoreEvent`s: a pod added under the target starts its streams (tail 500), a pod removed aborts them, `Restarted…InitDone` re-derives the target set. `stop_logs`, `select_namespace`, `disconnect` and `connect` abort every stream (`AbortOnDrop`). The channel is not used after `stop_logs`.

### Save

`save_text({ path, text })` writes the file (capability `dialog:allow-save`; the path comes from the save dialog). Manifests and logs are never logged by the backend.

### Contract

`docs/ipc-contract.md` gains a **Logs** section (commands, `LogMessage` union) and `src/shared/ipc/fixtures/log_message.json` guarded on both sides.

## 5. Frontend

- **`features/logs/logBuffer.ts`** — `LogBuffer`: ring buffer of 10 000 `{ seq, pod, container, text }`, `append(lines)`, `clear()`, `subscribe(cb)` (batched to one notification per animation frame), `lines()` snapshot for `useSyncExternalStore`. Lives outside zustand so a chatty pod re-renders only the log view.
- **Store** (`logs` slice): `{ gen: number, sessionId: number | null, nodeId, container, previous, timestamps, status: "idle" | "starting" | "streaming" | "ended" | "error", streams: Map<string, { state: "started" | "ended" | "error", message?: string }>, truncated: boolean }`. Actions: `startLogs(nodeId)`, `stopLogs()`, `setLogsContainer(name | null)`, `toggleLogsPrevious()`, `toggleLogsTimestamps()` — the last three restart the session. `select()`, `selectNamespace()`, `disconnect`/`connect` and leaving the tab call `stopLogs()`. `gen` comes from a module-level monotonic counter (bumped by every start and stop, never reset with the slice): messages from a superseded session (older `gen`) are dropped.
- **`features/logs/LogsTab.tsx`** — toolbar + `LogView` (`@tanstack/react-virtual`, `useSyncExternalStore` on the buffer, `anser` for ANSI → spans, search highlighting, stick-to-bottom logic). Wrap toggles `white-space: pre-wrap` and disables horizontal scroll.
- **`features/logs/ansi.ts`** — `toSpans(text) -> { text, className? }[]` via `anser`: foreground colours + bold only (the 8 base colours as theme classes, bright variants folded into them; everything else stripped to plain text).
- **Details panel**: `detailsHeight` (settings, default 320) with a `role="separator"` drag handle in `App.tsx`; `detailsMaximized` in the store (`toggleDetailsMaximized()`, reset on deselect), Esc handled in `useGlobalKeys` after the dialog layers and before `review → backToEdit`.
- Tabs: `TAB_KINDS.Logs = Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, PodGroup`.

## 6. Testing

- Rust: `logs::targets` on `podgroup` (7 pods), `relations` (Deployment → RS → Pod, CronJob → Job → Pod), Pod with init containers, container filter, invalid kind; batching (paused time: 50 ms flush, 256-line flush); StoreEvent reaction (pod added/removed); 64-stream cap → `truncated`; `LogMessage` fixture. Smoke: stream `web` (3 pods, `started` ×3, lines arrive), `crasher` with `previous`, `bad-image` → `error` with the waiting reason.
- Frontend: `LogBuffer` (ring overflow, batched notify), store (start/stop, restart on option change, stop on select/namespace/disconnect, stale session dropped, status transitions, truncated), `ansi.toSpans`, `LogsTab` (toolbar actions, search counter/stepping, follow button appears when unstuck, error lines, prefix only with >1 stream), separator (keyboard, clamping, persisted), maximise (button, Esc, deselect), tab visibility per kind.
- Live: `shop` — `web` merged logs with prefixes, `crasher` Previous, `bad-image` error line, `workers` PodGroup deletion → new pods join the stream, Download.

## 7. Decisions log

| Decision | Chosen | Alternatives |
|---|---|---|
| Transport | Tauri `Channel` per log session | `emit` events; polling `get_logs` |
| Workload logs | merged stream of member pods, `[pod/container]` prefix | Pod only |
| Follow | on by default, tail 500 | snapshot + refresh |
| Space | resizable + maximise details panel | separate window (later) |
| Buffer | 10 000 lines outside zustand | store-held array |
