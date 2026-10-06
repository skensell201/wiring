# Wiring — Terminal into a container (exec)

**Date:** 2026-10-06
**Status:** approved
**Builds on:** v0.3.0 (master), the Logs tab's session/Channel pattern (`src-tauri/src/logs/`, `src/features/logs/`).

## 1. Goal

Open an interactive shell in a running container from the details panel — the `kubectl exec -it … -- sh` experience without a terminal window: colours, cursor keys, resize, copy/paste.

## 2. Non-goals

Ephemeral debug containers (`kubectl debug`), running arbitrary one-off commands with captured output, file copy, several terminals at once, keeping a session alive after the selection changes, recording sessions, node shells.

## 3. User flows

- **Open.** Pods and workloads (Deployment, StatefulSet, DaemonSet, Job, PodGroup) get a **Terminal** tab after Logs. The toolbar has a **Pod** picker (workloads only: their Running pods, the first one preselected), a **Container** picker (regular containers; the first one preselected; init containers not offered) and **Connect** / **Disconnect**. Opening the tab does not connect by itself; **Connect** does (exec is a write-level action, so it is never started implicitly).
- **Shell.** The command is `sh -c "command -v bash >/dev/null && exec bash || exec sh"`, so bash is used when present. The terminal is an xterm.js view with the app's monospace font and theme colours, 5 000 lines of scrollback, and fits the panel; resizing the panel or window resizes the remote TTY.
- **End.** `exit` in the shell, **Disconnect**, switching the selection, the tab, the namespace or disconnecting the cluster ends the session; the view shows `[session ended]` (with the exit code when known) and offers **Reconnect**.
- **Errors** are lines in the terminal, not toasts: no shell in the image (`exec: "sh": executable file not found` → *This container has no shell (distroless image?)*), RBAC without `pods/exec` (*No permission to exec into pods (pods/exec)*), the pod not Running, the container not found.
- **Keys.** While the terminal has focus every key goes to the shell — including Escape, ⌘K / Ctrl+K and ⌘S — so app shortcuts don't steal them; xterm consumes Tab, so **Ctrl+Shift+Tab** (all platforms) moves focus out of the terminal to the toolbar's first enabled control without sending anything to the shell (the toolbar shows "Ctrl+Shift+Tab to leave"); clicking outside also returns keys to the app. Copy: select + ⌘C / Ctrl+Shift+C; paste: ⌘V / Ctrl+Shift+V.

## 4. Backend (`src-tauri/src/exec/`)

- `start_exec { nodeId, pod, container, cols, rows, onMessage: Channel<ExecMessage> }` → `sessionId`. Resolves the pod (a Pod id, or the given pod name for a workload, which must belong to that workload), checks it is Running and has the container, then `Api::<Pod>::exec(pod, ["sh","-c", …], AttachParams { stdin, stdout, tty: true, stderr: false, container })`. Errors before the websocket opens are returned (`forbidden` / `notFound` / `invalid` with the messages above); errors after it opens arrive as messages.
- `ExecMessage` (tagged by `type`): `output { data: string(base64) }`, `ended { code: number | null, message: string | null }`, `error { message }`. Output is forwarded in chunks as it arrives (no line buffering), base64 so binary/partial UTF-8 survives.
- `exec_input { sessionId, data: string(base64) }` writes to stdin; `exec_resize { sessionId, cols, rows }` sends a terminal-size update through the attached process's resize channel; `stop_exec { sessionId }` closes stdin and aborts. Sessions live with the namespace session (stopped on `select_namespace`, disconnect, reconnect), like log sessions.
- Exit code from the status channel (`Status.details.causes` `ExitCode`, or `Success` → 0).
- Nothing written to or read from the terminal is logged.

## 5. Frontend

- `@xterm/xterm` and `@xterm/addon-fit` (MIT) are added; xterm is loaded lazily (dynamic import) when the Terminal tab is first opened, so the main bundle doesn't grow.
- `src/features/exec/TerminalTab.tsx` (toolbar + view), `useExecSession` (start/stop, base64 bridge, resize on fit), theme mapping from `src/styles/theme.css` tokens.
- `useGlobalKeys` ignores key events whose target is inside the terminal.
- DetailsPanel: **Terminal** tab for the kinds above; the panel's maximise (⤢) works with it.

## 6. Testing

- **Rust unit:** pod/container resolution and validation (workload ownership, non-Running pod, unknown container, init container refused), error mapping (403 → pods/exec message, "executable file not found" → no-shell message), exit-code parsing from `Status`, base64 framing.
- **Smoke (docker-desktop only):** exec into the fixture's `talker` (or another busybox) pod, send `echo wiring-$((6*7))\n`, see `wiring-42` in the output, send `exit 3\n`, get `ended { code: 3 }`; exec into a distroless/scratch container if the fixture has one, else skip that step.
- **Vitest:** tab visibility per kind, pod/container pickers, Connect/Disconnect/Reconnect states, `[session ended]` line, input/resize calls (xterm mocked), global keys ignored while the terminal has focus, session stopped on selection change.

## 7. Decisions log

- Pods and workloads (with a pod picker), regular containers only.
- Explicit **Connect**; one session; ends with the selection/tab.
- bash if present, else sh; distroless gets a clear message.
- xterm.js, lazily loaded; base64 framing over a Tauri Channel like the Logs tab.
- The terminal owns the keyboard while focused.
