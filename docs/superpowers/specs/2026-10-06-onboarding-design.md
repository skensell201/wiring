# Wiring — Onboarding and empty states

**Date:** 2026-10-06
**Status:** approved (standing instruction: finish J; recommended options chosen, see §7)
**Builds on:** custom resources and Helm releases (merged to master as `e43e794`).

## 1. Goal

Make every place where Wiring has nothing to show explain why and offer the next step. Today a first-time user can hit an undismissable "no contexts" modal, a silently skipped broken kubeconfig, an 8-second toast labelled `network` or `auth`, or a blank canvas, and none of these say what to do. After this work, each of those situations says what happened, in plain words, with a button that moves the user forward.

## 2. Non-goals

A guided tour or wizard, a keyboard-shortcut sheet, cancelling a connection in flight, editing kubeconfig files, installing auth plugins for the user, and telemetry about first runs.

## 3. Situations and what the user sees

All centre-pane states use one shared `EmptyState` component: an icon, a title, one or two sentences, and up to two actions (primary and secondary). They replace the current one-line messages; toasts stay for transient events only.

| # | Situation | Title | Body | Actions |
|---|---|---|---|---|
| 1 | No contexts from any kubeconfig | Connect Wiring to a cluster | Wiring reads your kubeconfig, the file `kubectl` uses. Lists each source it looked at (see §4.1) with its state. | **Add kubeconfig…** · **Rescan** |
| 2 | Connecting | Connecting to `<context>`… | Spinner. The header shows the context name with a spinner too. | — |
| 3 | Connection failed | By cause (§4.3): *Can't reach the cluster*, *The cluster's certificate isn't trusted*, *Your credentials were rejected*, *The `<plugin>` login helper isn't installed*, *Connection timed out* | The server's message (first line), then the cause's hint. | **Retry** · **Choose another cluster** |
| 4 | Connected, no namespace chosen | Choose a namespace | "Pick one or more namespaces to see their resources." When namespaces can't be listed (`canListNamespaces` false): "You can't list namespaces on this cluster. Type the name of one you have access to." | Focuses / opens the namespace picker |
| 5 | Scope is empty | Nothing here yet | "`<scope>` has no resources." | **+ Create** · **Pick another namespace** |
| 6 | Every watched kind is denied in the scope | No access | "You can't list any resources in `<scope>` (RBAC). Ask your cluster admin, or pick another namespace." | **Pick another namespace** |
| 7 | Graph: every kind hidden by chips | All kinds are hidden | "Turn some kinds back on to see the graph." | **Show all kinds** |
| 8 | Graph: search matches nothing | No matches | "Nothing on the graph matches “q”." | **Clear search** |
| 9 | Too many objects for the graph | Too many objects to draw | "`N` objects in `<scope>`. Use the tables, or pick fewer namespaces." | **Pick fewer namespaces** · **Open tables** |

Other changes:

- **Too-large switch notice.** When the app switches from the graph to a table because of the guard, an info toast says so once per scope.
- **Degraded connection.** Next to the header dot: "Reconnecting…" text and a tooltip "Some resources can't be watched right now; Wiring keeps retrying."
- **Partial access in tables.** A built-in table of a `partial` kind shows a one-line note above the rows: "Some namespaces are missing: no access (RBAC)."
- **Toasts.** Error toasts get a human title per kind (*Network error*, *Authentication failed*, *Access denied*, *Not found*, *Conflict*, *Invalid*, *Something went wrong*) instead of the raw kind string.
- **Adding a kubeconfig.** Success toast "Added `<file>`: N contexts". A valid file with no contexts gets an error toast "`<file>` has no contexts" and is not saved.
- The undismissable "Choose a cluster" modal on first launch is removed: situation 1 is the centre pane, and the navigator's Clusters section keeps its own Add button.

## 4. Backend

### 4.1 Kubeconfig sources

New command `kubeconfig_sources` → `KubeconfigSource[]`, one per path Wiring looks at, in load order:

```
KubeconfigSource { path, origin: "env" | "default" | "added", state: "ok" | "missing" | "invalid" | "empty", contexts: number, error: string | null }
```

`error` is the first line of the parse/read error for `invalid`, else null. `kubeconfig.rs` gains a `scan(paths)` that returns these reports; `list_contexts` keeps its behaviour and reuses it. `add_kubeconfig` (the existing validation path) rejects a file with zero contexts with `Invalid` "`<file>` has no contexts".

### 4.2 Connect timeout

`connect` wraps the version probe and the namespace list in a 20-second timeout. On expiry it returns `Network` "timed out after 20 s waiting for <server>", and the session is not created.

### 4.3 Login helpers on PATH (macOS, Linux)

Apps started from the Dock or a desktop launcher don't inherit the shell's `PATH`, so kubeconfig exec plugins (`gke-gcloud-auth-plugin`, `aws`, `kubelogin`) installed with Homebrew or a cloud SDK are not found. At startup, before any kubeconfig is read, Wiring sets its own `PATH` to the login shell's: it runs `$SHELL -ilc 'printf %s "$PATH"'` with a 3-second timeout, and on failure or timeout appends the common directories that exist (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/google-cloud-sdk/bin`) to the current `PATH`. Windows is unchanged. The merge is a pure function (`merge_path(current, shell, extras)`) that keeps order and removes duplicates, unit-tested; the shell call is behind a seam.

### 4.4 Error causes

Classification lives in the frontend (`describeConnectError(error)`, pure): from `kind` and `message`:

- `auth` with "(exec plugin: `<name>`)" → *login helper isn't installed*; hint per known plugin: `gke-gcloud-auth-plugin` → `gcloud components install gke-gcloud-auth-plugin`; `aws` → install the AWS CLI; `kubelogin` → `brew install Azure/kubelogin/kubelogin`; others → "Install `<name>` and make sure it is on your PATH". The hint ends with "Wiring uses your login shell's PATH; restart Wiring after installing it."
- `auth` otherwise → *credentials were rejected*; hint "Log in again with your provider's CLI, then Retry."
- `network` with certificate/TLS/x509 wording → *certificate isn't trusted*; hint "Check the cluster's CA in your kubeconfig."
- `network` with "timed out" → *Connection timed out*; hint "Check your VPN or network."
- `network` otherwise → *Can't reach the cluster*; same hint.
- anything else → *Couldn't connect*, message only.

## 5. Frontend

- `src/shared/EmptyState.tsx`: the shared component (icon, title, body, actions), using existing theme tokens.
- Store: `connection.state` gains `"connecting"` (if not present) and `connection.lastError: { context, error } | null`, set on a failed connect and cleared by the next connect, context switch or disconnect. `retryConnect()` reconnects the last attempted context.
- `kubeconfigSources` state and `loadKubeconfigSources()` (on start, after Add, on Rescan).
- Canvas, TableView, CustomTableView and HelmView use `EmptyState` for their messages; the situation logic is one pure function per view (`graphEmptyState(...)`), unit-tested.
- Namespace picker exposes an `openNamespacePicker()` action so empty states can open it.

## 6. Testing

- **Rust:** `scan` reports `ok` / `missing` / `invalid` (with first error line) / `empty` and origins; `add_kubeconfig` rejects a context-less file; the connect timeout fires (a test server that never answers, or the timeout logic behind a seam with a short duration); `merge_path` keeps order, drops duplicates and appends only existing extras.
- **Vitest:** `describeConnectError` for every cause; `graphEmptyState` for situations 4–9 in priority order; the welcome pane lists sources and Add/Rescan call the commands; the failure pane shows title + hint and Retry reconnects; toasts show human titles; the partial note; the too-large toast fires once per scope.
- **Smoke:** none new (states are frontend; the timeout is unit-tested).

## 7. Decisions log

- Approach: one shared empty-state component with a per-situation title, body and actions (chosen over a first-run wizard or text-only tweaks).
- First launch shows the welcome pane instead of an undismissable modal.
- Connect errors are classified in the frontend from the existing `AppError`; the backend adds the timeout, the kubeconfig source reports and the login-shell `PATH`.
- Situations are resolved in a fixed priority: not connected → connecting → failed → no namespace → too large → no access → empty → all kinds hidden → search no match.
