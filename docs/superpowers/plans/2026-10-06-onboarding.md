# Onboarding and Empty States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Every place where Wiring has nothing to show says why, in plain words, with a button that moves the user forward: a welcome pane listing the kubeconfig files Wiring read, a connecting pane, a connection-failure pane that names the cause, and shared empty states for the graph and every table. The backend adds the kubeconfig source reports, a 20-second connect timeout and the login shell's `PATH`.

**Architecture:** The backend gains `kubeconfig::scan` (one `KubeconfigSource` report per path) behind a new `kubeconfig_sources` command. `add_kubeconfig` rejects a file with no contexts. `Session::connect` bounds the API server's answer with a testable `within(limit, server, fut)`. A unix-only `shell_path` module merges the login shell's `PATH` into the process at startup. The frontend adds one `EmptyState` component and one pure situation function per view: `graphEmptyState`, `tableEmptyState`, `connectionPane` and `describeConnectError`. The store tracks the context being dialled, the last failed connect, the kubeconfig sources and namespace-picker requests. The undismissable first-launch modal is removed.

**Tech Stack:** Rust (kube 4.2 `Kubeconfig`, tokio `time::timeout`, `std::process`), React/TS + zustand + Tailwind theme tokens + lucide-react, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-06-onboarding-design.md`. **Branch:** `feat/onboarding` (already checked out, from master `e43e794`).

Every commit in this plan ends with these two trailer lines. They are shown once here and written as `<trailers>` in each commit step:

```text
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz
```

so a commit step `git commit -m "Subject" -m "<trailers>"` means:

```bash
git commit -m "Subject" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01G2aAf83oMmREM6p6qeFCcz"
```

Run Rust commands from `src-tauri/` and pnpm commands from the repository root. After every `pnpm vitest run`, check the exit code (`echo $?` must print `0`). The pass count alone is not enough: an unhandled rejection fails the run even when every test passes.

## Deviations from the spec

The code differs from the spec's assumptions in these places. The plan follows the code.

1. **No `"connecting"` value in `connection.state`.** `connection.state` mirrors the backend's `ConnectionState` (`connected | degraded | disconnected`), and `Dot` colours are keyed by it. A connect in flight is already marked by `connection.busy`. The plan adds `connection.connecting: string | null`, the context being dialled, which the header and the centre pane read. `busy` stays as it is, because `wireEvents` relies on it.
2. **A failed connect no longer toasts.** The failure pane shows the error, and the spec keeps toasts for transient events. The existing store test "connect failure becomes a toast" is rewritten to match.
3. **The whole `ContextPicker` modal goes.** It only ever opened when there were no contexts (from `startup`, `disconnectedState` and the header button), so it *was* the undismissable modal. The plan removes the component together with `pickerOpen` and `setPickerOpen`. The header's context button always toggles the navigator.
4. **One more pane, "Choose a cluster".** The spec has no situation for "contexts exist, nothing connected, no failure". Today the canvas shows "Connect to a cluster to see its graph." The plan shows an `EmptyState` that points to the navigator, with **Add kubeconfig…**.
5. **The kubeconfig sources are loaded by the welcome pane when it mounts**, and again after Add and on Rescan. `startup` does not load them unconditionally. The welcome pane is the only screen that lists them, and it mounts at start exactly when there are no contexts. An extra `invoke` in `startup` would also shift the `mockImplementationOnce` sequences of the existing startup tests.
6. **A login helper counts as "not installed" only when kube failed to start it.** `app_error_from_client` appends `(exec plugin: <cmd>)` to *every* `Auth` error of a context that has an exec plugin, a server's 401 included. So `describeConnectError` also requires spawn-failure wording (`unable to run auth exec`, `No such file`, `not found`, `cannot find`, `os error 2`). Any other `auth` error is *credentials were rejected*. `<cmd>` may be a full path, so its basename picks the hint. The timeout check runs before the certificate check, because a server URL can contain `ssl`. Certificate wording is recognised on `internal` errors too, because rustls failures do not always surface as `network`.
7. **"Every watched kind is denied" means every namespaced watched kind.** `PersistentVolume`, `ClusterRole`, `ClusterRoleBinding` and `Node` are cluster-scoped, and their RBAC does not depend on the scope.
8. **The existing loading state stays** between "no namespace" and "too large": *Loading `<scope>`…*.
9. **The too-large graph pane (situation 9) shows only until the next snapshot.** `applySnapshot` already moves a too-large graph to a table, and that behaviour stays. The new toast says so once per scope.
10. **One shared pure `tableEmptyState`** serves `TableView`, `CustomTableView` and `HelmView`, with a per-view noun ("Pods", "certificates", "Helm releases"). The spec asks for one pure function per view. The three table views share the same five situations. The custom table's terminal watch error keeps its **Retry**, now inside an `EmptyState`.
11. **The login-shell `PATH` is set in `wiring_lib::run()`**, which `main.rs` calls, right after tracing starts and before the Tauri builder. Nothing has read a kubeconfig at that point. The module is `#[cfg(unix)]`, so Windows is unchanged. `merge_path` puts the shell's entries first, then the current ones, then the common directories that exist. It appends them even when the shell answered, which is harmless and keeps one code path.
12. **The connect timeout covers the version probe and the namespace list**, as specified. Client setup, where an exec plugin may run, stays outside it, as today. The message prints the limit as `20 s`. Sub-second limits, which only tests use, print as `300 ms`. A trailing `/` of the cluster URL is dropped.
13. **The "Added `<file>`: N contexts" count comes from the `kubeconfig_sources` report for that path.** It does not come from `add_kubeconfig`'s `ContextInfo[]`, which is merged first-file-wins and would undercount a file whose context names repeat another file's.
14. **The no-contexts error names the file by its basename** (`team.yaml has no contexts`), matching the success toast.

---

## File structure

| File | Responsibility |
|---|---|
| `src-tauri/src/kubeconfig.rs` | `SourceOrigin`, `SourceState`, `KubeconfigSource`, `default_sources`, `scan`; `validate_file` rejects a context-less file |
| `src-tauri/src/commands.rs` | `kubeconfig_sources` command; sources-with-origin helper |
| `src-tauri/src/session/mod.rs` | `CONNECT_TIMEOUT`, `within`, `Session::connect_within` |
| `src-tauri/src/shell_path.rs` (new) | `merge_path`, `run_with_timeout`, `login_shell_path`, `apply_login_shell_path` |
| `src-tauri/src/lib.rs` | `#[cfg(unix)] pub mod shell_path;`, call at startup |
| `src-tauri/tests/ipc_fixtures.rs`, `src/shared/ipc/fixtures/kubeconfig_source.json` (new), `docs/ipc-contract.md` | contract |
| `src/shared/ipc/{types,commands}.ts`, `src/shared/ipc/fixtures.test.ts` | `KubeconfigSource`, guard, `kubeconfigSources()` |
| `src/shared/EmptyState.tsx` (new) + test | the shared centre-pane state |
| `src/app/store.ts` | `connecting`, `lastError`, `retryConnect`, `dismissConnectError`, `kubeconfigSources`, `loadKubeconfigSources`, `rescanKubeconfigs`, `openNamespacePicker`, `showAllKinds`, `tooLargeNotified`, add-kubeconfig toasts; `pickerOpen` removed |
| `src/app/store.onboarding.test.ts` (new) | store tests for all of the above |
| `src/app/startup.ts` | no modal when there are no contexts |
| `src/app/useGlobalKeys.ts` | `pickerOpen` gone |
| `src/features/onboarding/describeConnectError.ts` (new) + test | cause, title, detail, hint of a connect error |
| `src/features/onboarding/panes.ts` (new) | `connectionPane()`: which pane replaces the views |
| `src/features/onboarding/ConnectionPane.tsx` (new) + test | welcome, choose, connecting and failure panes |
| `src/features/graph/toFlow.ts` | `visibleNodes`, `matchesSearch` exported |
| `src/features/graph/graphEmptyState.ts` (new) + test | graph situations in priority order, `NAMESPACED_KINDS`, `noNamespaceBody` |
| `src/features/graph/GraphEmpty.tsx` (new), `Canvas.tsx` | graph empty states |
| `src/features/table/tableEmptyState.ts` (new) + test, `TableEmpty.tsx` (new) | table situations and their rendering |
| `src/features/table/TableView.tsx`, `CustomTableView.tsx`, `src/features/helm/HelmView.tsx` | use `TableEmpty`; partial note in `TableView` |
| `src/features/cluster/NamespacePicker.tsx` | opens (or focuses its field) on `openNamespacePicker()` |
| `src/features/cluster/Header.tsx` | context button toggles the navigator; connecting spinner; "Reconnecting…" |
| `src/features/cluster/ContextPicker.tsx` | deleted |
| `src/shared/ui/Toasts.tsx` + new test | human titles per error kind |
| `src/App.tsx` | connection pane instead of the views when there is no session |
| `README.md` | welcome pane, login helpers, empty states |

---

### Task 1: Kubeconfig source reports

**Files:**
- Modify: `src-tauri/src/kubeconfig.rs`

- [ ] **Step 1: Write the failing tests.** In `src-tauri/src/kubeconfig.rs`, add to `mod tests`, after `fn unparseable_file`:

```rust
    fn empty_file(dir: &std::path::Path) -> PathBuf {
        let path = dir.join("empty");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"apiVersion: v1\nkind: Config\nclusters: []\nusers: []\ncontexts: []\n")
            .unwrap();
        path
    }

    #[test]
    fn scan_reports_each_source_with_its_state_and_origin() {
        let dir = tempfile::tempdir().unwrap();
        let good = kubeconfig_file(dir.path(), "good", &[("prod", "c1", "u1"), ("dev", "c1", "u1")]);
        let missing = dir.path().join("nope");
        let bad = unparseable_file(dir.path());
        let empty = empty_file(dir.path());
        let reports = scan(&[
            (good.clone(), SourceOrigin::Env),
            (missing.clone(), SourceOrigin::Default),
            (bad.clone(), SourceOrigin::Added),
            (empty.clone(), SourceOrigin::Added),
        ]);
        let s = |p: &PathBuf| p.to_string_lossy().into_owned();
        let summary: Vec<_> = reports.iter().map(|r| (r.path.clone(), r.origin, r.state, r.contexts)).collect();
        assert_eq!(
            summary,
            vec![
                (s(&good), SourceOrigin::Env, SourceState::Ok, 2),
                (s(&missing), SourceOrigin::Default, SourceState::Missing, 0),
                (s(&bad), SourceOrigin::Added, SourceState::Invalid, 0),
                (s(&empty), SourceOrigin::Added, SourceState::Empty, 0),
            ]
        );
        assert_eq!(reports[0].error, None);
        assert_eq!(reports[1].error, None);
        assert_eq!(reports[3].error, None);
        let err = reports[2].error.as_deref().expect("an invalid source says why");
        assert!(!err.is_empty() && !err.contains('\n') && !err.contains("abc"), "{err}");
    }

    #[test]
    fn sources_come_from_kubeconfig_or_the_default_location() {
        let sep = if cfg!(windows) { ';' } else { ':' };
        let home = Some(PathBuf::from("/home/me"));
        assert_eq!(
            sources_from(Some(format!("/a/one{sep}/b/two").as_str()), home.clone()),
            vec![
                (PathBuf::from("/a/one"), SourceOrigin::Env),
                (PathBuf::from("/b/two"), SourceOrigin::Env)
            ]
        );
        let default = vec![(PathBuf::from("/home/me").join(".kube").join("config"), SourceOrigin::Default)];
        assert_eq!(sources_from(None, home.clone()), default);
        assert_eq!(sources_from(Some(""), home), default, "an empty KUBECONFIG falls back to the default");
        assert_eq!(sources_from(None, None), vec![]);
    }

    #[test]
    fn source_reports_serialize_in_camel_case() {
        let r = KubeconfigSource {
            path: "/k".into(),
            origin: SourceOrigin::Added,
            state: SourceState::Empty,
            contexts: 0,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            serde_json::json!({ "path": "/k", "origin": "added", "state": "empty", "contexts": 0, "error": null })
        );
    }
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `cargo test --lib kubeconfig`. Expected: FAIL to compile, with `cannot find function 'scan'`, `cannot find type 'SourceOrigin'` and `cannot find function 'sources_from'`.

- [ ] **Step 3: Implement.** In `src-tauri/src/kubeconfig.rs`, add after the `ContextInfo` struct:

```rust
/// Where a kubeconfig path came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceOrigin {
    /// An entry of `$KUBECONFIG`.
    Env,
    /// `~/.kube/config`, used when `$KUBECONFIG` is unset or empty.
    Default,
    /// Added in the app ("Add kubeconfig…").
    Added,
}

/// What a kubeconfig path held when it was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceState {
    Ok,
    Missing,
    Invalid,
    Empty,
}

/// One path Wiring reads kubeconfig from, for the welcome pane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeconfigSource {
    pub path: String,
    pub origin: SourceOrigin,
    pub state: SourceState,
    /// The file's own contexts, before the first-file-wins merge of `list_contexts`.
    pub contexts: usize,
    /// First line of the read/parse error when `state` is `Invalid`.
    pub error: Option<String>,
}
```

Then replace everything from the `/// `$KUBECONFIG` entries if set, otherwise `~/.kube/config`.` doc comment down to the end of `fn read_existing` with:

```rust
/// `kubeconfig_env` entries (`$KUBECONFIG`) if any, otherwise `<home>/.kube/config`.
fn sources_from(kubeconfig_env: Option<&str>, home: Option<PathBuf>) -> Vec<(PathBuf, SourceOrigin)> {
    if let Some(env) = kubeconfig_env {
        let paths = split_env_paths(env);
        if !paths.is_empty() {
            return paths.into_iter().map(|p| (p, SourceOrigin::Env)).collect();
        }
    }
    home.map(|h| vec![(h.join(".kube").join("config"), SourceOrigin::Default)])
        .unwrap_or_default()
}

/// `$KUBECONFIG` entries if set, otherwise `~/.kube/config`, each with its origin.
pub fn default_sources() -> Vec<(PathBuf, SourceOrigin)> {
    sources_from(std::env::var("KUBECONFIG").ok().as_deref(), dirs::home_dir())
}

/// `$KUBECONFIG` entries if set, otherwise `~/.kube/config`.
pub fn default_paths() -> Vec<PathBuf> {
    default_sources().into_iter().map(|(p, _)| p).collect()
}

/// One path, read.
enum Read {
    Missing,
    Invalid(String),
    Parsed(Kubeconfig),
}

fn read_one(path: &Path) -> Read {
    if !path.exists() {
        return Read::Missing;
    }
    match Kubeconfig::read_from(path) {
        Ok(cfg) => Read::Parsed(cfg),
        Err(e) => Read::Invalid(first_line(&e)),
    }
}

/// Reads every existing, parseable file. Missing files are skipped silently;
/// unreadable/unparseable files are skipped with a warning — neither aborts
/// the caller, since a single bad file shouldn't hide the rest.
fn read_existing(paths: &[PathBuf]) -> Vec<(PathBuf, Kubeconfig)> {
    let mut out = vec![];
    for p in paths {
        match read_one(p) {
            Read::Missing => tracing::debug!(path = %p.display(), "kubeconfig not found, skipping"),
            Read::Invalid(error) => tracing::warn!(path = %p.display(), error = %error, "skipping unreadable kubeconfig"),
            Read::Parsed(cfg) => out.push((p.clone(), cfg)),
        }
    }
    out
}

/// What each source holds, in the order given (the load order).
pub fn scan(sources: &[(PathBuf, SourceOrigin)]) -> Vec<KubeconfigSource> {
    sources
        .iter()
        .map(|(path, origin)| {
            let (state, contexts, error) = match read_one(path) {
                Read::Missing => (SourceState::Missing, 0, None),
                Read::Invalid(e) => (SourceState::Invalid, 0, Some(e)),
                Read::Parsed(cfg) if cfg.contexts.is_empty() => (SourceState::Empty, 0, None),
                Read::Parsed(cfg) => (SourceState::Ok, cfg.contexts.len(), None),
            };
            KubeconfigSource {
                path: path.to_string_lossy().into_owned(),
                origin: *origin,
                state,
                contexts,
                error,
            }
        })
        .collect()
}
```

`split_env_paths` stays where it is, above this block. `list_contexts` and `load_merged` keep calling `read_existing`, so their behaviour does not change.

- [ ] **Step 4: Run the tests to see them pass.** Run: `cargo test --lib kubeconfig`. Expected: PASS. All `kubeconfig::tests` pass, including the three new ones and the existing `missing_file_is_skipped_not_fatal` and `unparseable_file_is_skipped_with_others_listed`.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/kubeconfig.rs
git commit -m "Report what each kubeconfig source holds" -m "<trailers>"
```

---

### Task 2: `kubeconfig_sources` command; reject a kubeconfig without contexts

**Files:**
- Modify: `src-tauri/src/kubeconfig.rs`, `src-tauri/src/commands.rs`

- [ ] **Step 1: Write the failing test.** In `src-tauri/src/kubeconfig.rs` `mod tests`, add:

```rust
    #[test]
    fn validate_file_rejects_a_file_without_contexts() {
        let dir = tempfile::tempdir().unwrap();
        let err = validate_file(&empty_file(dir.path())).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "empty has no contexts");
        let good = kubeconfig_file(dir.path(), "good", &[("prod", "c1", "u1")]);
        assert!(validate_file(&good).is_ok());
    }
```

- [ ] **Step 2: Run the test to see it fail.** Run: `cargo test --lib kubeconfig::tests::validate_file_rejects`. Expected: FAIL with `called Result::unwrap_err() on an Ok value`.

- [ ] **Step 3: Implement.** Replace `validate_file` in `src-tauri/src/kubeconfig.rs` with:

```rust
/// Validates a single file before it's added as a kubeconfig source, so the
/// UI can surface a clean error instead of failing later inside `load_merged`.
/// A file without contexts would add nothing, so it is refused too.
pub fn validate_file(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::new(ErrorKind::NotFound, format!("{} does not exist", path.display())));
    }
    let cfg = Kubeconfig::read_from(path).map_err(|e| {
        AppError::new(
            ErrorKind::Internal,
            format!("{}: invalid kubeconfig ({})", path.display(), first_line(&e)),
        )
    })?;
    if cfg.contexts.is_empty() {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        return Err(AppError::new(ErrorKind::Invalid, format!("{name} has no contexts")));
    }
    Ok(())
}
```

In `src-tauri/src/commands.rs`, change the import:

```rust
use crate::kubeconfig::{self, ContextInfo, KubeconfigSource, SourceOrigin};
```

Replace `fn all_kubeconfig_paths` with:

```rust
/// Every kubeconfig path in load order (`$KUBECONFIG` or `~/.kube/config`, then the added files), with its origin.
fn all_kubeconfig_sources(app: &AppHandle) -> Vec<(PathBuf, SourceOrigin)> {
    let mut sources = kubeconfig::default_sources();
    sources.extend(extra_kubeconfigs(app).into_iter().map(|p| (p, SourceOrigin::Added)));
    sources
}

fn all_kubeconfig_paths(app: &AppHandle) -> Vec<PathBuf> {
    all_kubeconfig_sources(app).into_iter().map(|(p, _)| p).collect()
}
```

After the `list_contexts` command, add:

```rust
/// What each kubeconfig path holds, for the welcome pane.
#[tauri::command]
pub fn kubeconfig_sources(app: AppHandle) -> AppResult<Vec<KubeconfigSource>> {
    Ok(kubeconfig::scan(&all_kubeconfig_sources(&app)))
}
```

In `register`, add `kubeconfig_sources,` on the line after `add_kubeconfig,`. `add_kubeconfig` needs no change: it already calls `validate_file` before saving anything, so a context-less file is refused and not saved.

- [ ] **Step 4: Run the tests and the build.** Run: `cargo test --lib kubeconfig && cargo clippy --all-targets -- -D warnings`. Expected: PASS. The tests pass, and clippy reports no warnings.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/kubeconfig.rs src-tauri/src/commands.rs
git commit -m "List kubeconfig sources and refuse a kubeconfig without contexts" -m "<trailers>"
```

---

### Task 3: Connect timeout

**Files:**
- Modify: `src-tauri/src/session/mod.rs`

- [ ] **Step 1: Write the failing tests.** In `src-tauri/src/session/mod.rs` `mod tests`, add after `missing_exec_plugin_is_an_auth_error_naming_the_binary`:

```rust
    #[tokio::test(start_paused = true)]
    async fn within_gives_up_after_the_limit_with_a_network_error() {
        let err = within(CONNECT_TIMEOUT, "https://10.0.0.1:6443", std::future::pending::<AppResult<()>>())
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Network);
        assert_eq!(err.message, "timed out after 20 s waiting for https://10.0.0.1:6443");
    }

    #[tokio::test]
    async fn within_passes_an_answer_through() {
        assert_eq!(within(CONNECT_TIMEOUT, "s", async { Ok(7) }).await.unwrap(), 7);
        let err = within(CONNECT_TIMEOUT, "s", async { Err::<(), _>(AppError::new(ErrorKind::Auth, "no")) })
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Auth);
    }

    #[tokio::test]
    async fn connect_times_out_when_the_server_never_answers() {
        use crate::session::emitter::ChannelEmitter;
        // The kernel accepts the TCP connection into the backlog; nothing ever answers the TLS hello.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let kubeconfig = Kubeconfig::from_yaml(&format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://127.0.0.1:{port}\n    insecure-skip-tls-verify: true\nusers:\n- name: u\n  user:\n    token: abc\ncontexts:\n- name: ctx\n  context:\n    cluster: c\n    user: u\ncurrent-context: ctx\n"
        ))
        .unwrap();
        let (emitter, _rx) = ChannelEmitter::new();
        let started = std::time::Instant::now();
        let err = Session::connect_within(kubeconfig, "ctx", Arc::new(emitter), Duration::from_millis(300))
            .await
            .err()
            .expect("connect must time out");
        assert_eq!(err.kind, ErrorKind::Network, "{err:?}");
        assert_eq!(err.message, format!("timed out after 300 ms waiting for https://127.0.0.1:{port}"));
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        drop(listener);
    }
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `cargo test --lib session::tests`. Expected: FAIL to compile, with `cannot find function 'within'`, `cannot find value 'CONNECT_TIMEOUT'` and `no function or associated item named 'connect_within'`.

- [ ] **Step 3: Implement.** In `src-tauri/src/session/mod.rs`, add to the `use std::…` imports:

```rust
use std::future::Future;
use std::time::Duration;
```

Add after `fn app_error_from_client`:

```rust
/// How long `connect` waits for the API server to answer the version probe and the namespace list.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// "20 s", or "300 ms" for a sub-second limit (tests use those).
fn limit_text(limit: Duration) -> String {
    if limit.subsec_millis() == 0 {
        format!("{} s", limit.as_secs())
    } else {
        format!("{} ms", limit.as_millis())
    }
}

/// `fut`'s result, or a `Network` error once `limit` passes without one. A server that accepts
/// the connection but never answers (a half-up VPN, a firewall dropping packets) would
/// otherwise leave `connect` hanging with the session lock held.
async fn within<T>(limit: Duration, server: &str, fut: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    tokio::time::timeout(limit, fut).await.unwrap_or_else(|_| {
        Err(AppError::new(
            ErrorKind::Network,
            format!("timed out after {} waiting for {server}", limit_text(limit)),
        ))
    })
}
```

Replace `pub async fn connect` in `impl Session` with:

```rust
    pub async fn connect(kubeconfig: Kubeconfig, context: &str, emitter: Arc<dyn Emitter>) -> AppResult<(Session, ConnectInfo)> {
        Self::connect_within(kubeconfig, context, emitter, CONNECT_TIMEOUT).await
    }

    /// `connect`, with the API server's answer bounded by `limit`.
    async fn connect_within(
        kubeconfig: Kubeconfig,
        context: &str,
        emitter: Arc<dyn Emitter>,
        limit: Duration,
    ) -> AppResult<(Session, ConnectInfo)> {
        let options = KubeConfigOptions {
            context: Some(context.to_string()),
            cluster: None,
            user: None,
        };
        let exec_command = exec_plugin_command(&kubeconfig, context);
        let context_namespace = find_context(&kubeconfig, context).and_then(|c| c.namespace.clone());
        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| AppError::from(&e))?;
        let server = config.cluster_url.to_string().trim_end_matches('/').to_string();
        // `Client::try_from` runs the exec plugin synchronously (it can block for seconds),
        // so keep it off the async runtime threads.
        let client = tokio::task::spawn_blocking(move || Client::try_from(config))
            .await
            .map_err(|e| AppError::internal(format!("client setup task failed: {e}")))?
            .map_err(|e| app_error_from_client(&e, exec_command.as_deref()))?;

        let probe = async {
            let version = client
                .apiserver_version()
                .await
                .map_err(|e| app_error_from_client(&e, exec_command.as_deref()))?;
            let listed = Api::<Namespace>::all(client.clone())
                .list(&ListParams::default())
                .await
                .map(|list| list.items.into_iter().filter_map(|n| n.metadata.name).collect::<Vec<_>>());
            Ok::<_, AppError>((version, listed))
        };
        let (version, listed) = within(limit, &server, probe).await?;
        let (namespaces, can_list_namespaces) = namespaces_or_fallback(listed, context_namespace.as_deref())?;

        let info = ConnectInfo {
            context: context.to_string(),
            server_version: version.git_version,
            namespaces,
            can_list_namespaces,
        };
        let mut session = Session::new(client, emitter);
        session.namespaces = can_list_namespaces.then(|| info.namespaces.clone());
        Ok((session, info))
    }
```

- [ ] **Step 4: Run the tests to see them pass.** Run: `cargo test --lib session::tests`. Expected: PASS. `within_gives_up_after_the_limit_with_a_network_error`, `within_passes_an_answer_through` and `connect_times_out_when_the_server_never_answers` pass (the last within about 0.3 s), and the existing `missing_exec_plugin_is_an_auth_error_naming_the_binary` still passes.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/session/mod.rs
git commit -m "Give up connecting after 20 seconds without an answer" -m "<trailers>"
```

---

### Task 4: Login shell's PATH on macOS and Linux

**Files:**
- Create: `src-tauri/src/shell_path.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing tests.** Create `src-tauri/src/shell_path.rs` with the test module only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_the_shells_order_first_and_drops_duplicates() {
        assert_eq!(
            merge_path("/usr/bin:/bin", Some("/opt/homebrew/bin:/usr/bin"), &[]),
            "/opt/homebrew/bin:/usr/bin:/bin"
        );
    }

    #[test]
    fn merge_appends_only_extras_that_exist() {
        let dir = tempfile::tempdir().unwrap();
        let there = dir.path().to_path_buf();
        let merged = merge_path(
            "/usr/bin",
            None,
            &[PathBuf::from("/nonexistent/wiring-bin"), there.clone(), PathBuf::from("/usr/bin")],
        );
        assert_eq!(merged, format!("/usr/bin:{}", there.display()));
    }

    #[test]
    fn merge_drops_empty_entries() {
        assert_eq!(merge_path("/usr/bin::/bin:", Some(""), &[]), "/usr/bin:/bin");
    }

    #[test]
    fn run_with_timeout_returns_the_output_of_a_successful_command() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "printf %s hello"]);
        assert_eq!(run_with_timeout(cmd, Duration::from_secs(5)).as_deref(), Some("hello"));
    }

    #[test]
    fn run_with_timeout_gives_up_on_failure_and_on_a_slow_command() {
        assert_eq!(run_with_timeout(Command::new("/usr/bin/false"), Duration::from_secs(5)), None);
        assert_eq!(run_with_timeout(Command::new("/nonexistent/wiring-shell"), Duration::from_secs(5)), None);
        let mut slow = Command::new("/bin/sleep");
        slow.arg("5");
        let started = Instant::now();
        assert_eq!(run_with_timeout(slow, Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[test]
    fn login_shell_path_reads_the_shells_path() {
        let path = login_shell_path(Path::new("/bin/sh"), SHELL_TIMEOUT).expect("sh prints its PATH");
        assert!(path.contains('/'), "{path}");
        assert!(!path.contains('\n'), "{path}");
    }
}
```

In `src-tauri/src/lib.rs`, add after `pub mod session;`:

```rust
#[cfg(unix)]
pub mod shell_path;
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `cargo test --lib shell_path`. Expected: FAIL to compile, with `cannot find function 'merge_path'`, `cannot find function 'run_with_timeout'` and `cannot find type 'Command'`.

- [ ] **Step 3: Implement.** Put this above the test module in `src-tauri/src/shell_path.rs`:

```rust
//! Give the app the login shell's `PATH` (macOS, Linux).
//!
//! An app started from the Dock or a desktop launcher inherits a minimal `PATH`, so kubeconfig
//! exec plugins installed with Homebrew or a cloud SDK (`gke-gcloud-auth-plugin`, `aws`,
//! `kubelogin`) are not found. At startup, before any kubeconfig is read, the app asks the
//! user's login shell for its `PATH` and merges it into its own.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long the login shell gets to print its `PATH`.
pub const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

/// `shell`'s entries, then `current`'s, then the `extras` that exist as directories, in that
/// order, without empty entries or duplicates.
pub fn merge_path(current: &str, shell: Option<&str>, extras: &[PathBuf]) -> String {
    let listed = shell
        .into_iter()
        .chain(std::iter::once(current))
        .flat_map(|s: &str| std::env::split_paths(s).collect::<Vec<_>>());
    let existing = extras.iter().filter(|p| p.is_dir()).cloned();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in listed.chain(existing) {
        if !p.as_os_str().is_empty() && seen.insert(p.clone()) {
            out.push(p);
        }
    }
    std::env::join_paths(out)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| current.to_string())
}

/// `cmd`'s stdout if it exits successfully within `timeout`; otherwise it is killed and `None`.
pub fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    // Read on a thread, so a background job of the shell that keeps stdout open cannot block startup.
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok()
}

/// The `PATH` an interactive login `shell` sets up, or `None` when it fails or takes too long.
pub fn login_shell_path(shell: &Path, timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(shell);
    cmd.args(["-ilc", "printf %s \"$PATH\""]);
    let out = run_with_timeout(cmd, timeout)?;
    // rc files may print banners first; the PATH is what follows the last newline.
    let path = out.rsplit('\n').next().unwrap_or_default().trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Directories that commonly hold login helpers; only the existing ones are added.
fn common_dirs() -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")];
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".local/bin"));
        out.push(home.join("google-cloud-sdk/bin"));
    }
    out
}

fn default_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/sh"
    }
}

/// Sets this process's `PATH` to the login shell's merged with the current one (or, when the
/// shell does not answer, the current one plus the common tool directories). Call once at
/// startup, before any other thread reads the environment.
pub fn apply_login_shell_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_shell().to_string());
    let from_shell = login_shell_path(Path::new(&shell), SHELL_TIMEOUT);
    if from_shell.is_none() {
        tracing::warn!(shell = %shell, "could not read the login shell's PATH; adding the common tool directories");
    }
    let merged = merge_path(&current, from_shell.as_deref(), &common_dirs());
    tracing::debug!(path = %merged, "PATH for kubeconfig exec plugins");
    std::env::set_var("PATH", merged);
}
```

In `src-tauri/src/lib.rs` `run()`, add right after the `tracing_subscriber::fmt()…init();` statement:

```rust
    // Before any kubeconfig is read: exec plugins (gke-gcloud-auth-plugin, aws, kubelogin) must
    // be found on the login shell's PATH even when the app was started from the Dock.
    #[cfg(unix)]
    shell_path::apply_login_shell_path();
```

- [ ] **Step 4: Run the tests and clippy.** Run: `cargo test --lib shell_path && cargo clippy --all-targets -- -D warnings`. Expected: PASS. The six `shell_path::tests` pass, and clippy reports no warnings.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/shell_path.rs src-tauri/src/lib.rs
git commit -m "Use the login shell's PATH so kubeconfig login helpers are found" -m "<trailers>"
```

---

### Task 5: IPC contract, fixture, TypeScript type and command

**Files:**
- Create: `src/shared/ipc/fixtures/kubeconfig_source.json`
- Modify: `src-tauri/tests/ipc_fixtures.rs`, `src/shared/ipc/types.ts`, `src/shared/ipc/commands.ts`, `src/shared/ipc/fixtures.test.ts`, `docs/ipc-contract.md`

- [ ] **Step 1: Write the fixture and the failing tests.** Create `src/shared/ipc/fixtures/kubeconfig_source.json`:

```json
{
  "path": "/Users/alice/.kube/config",
  "origin": "default",
  "state": "invalid",
  "contexts": 0,
  "error": "did not find expected key at line 3 column 1"
}
```

In `src-tauri/tests/ipc_fixtures.rs`, change `use wiring_lib::kubeconfig::ContextInfo;` to:

```rust
use wiring_lib::kubeconfig::{ContextInfo, KubeconfigSource, SourceOrigin, SourceState};
```

and add after `fn context_info`:

```rust
#[test]
fn kubeconfig_source() {
    assert_matches(
        "kubeconfig_source",
        &KubeconfigSource {
            path: "/Users/alice/.kube/config".into(),
            origin: SourceOrigin::Default,
            state: SourceState::Invalid,
            contexts: 0,
            error: Some("did not find expected key at line 3 column 1".into()),
        },
    );
}
```

In `src/shared/ipc/fixtures.test.ts`, add `import kubeconfigSource from "./fixtures/kubeconfig_source.json";` after the `helmReleaseDetails` import. In the `./types` import list, insert `isKubeconfigSource, ` right after `isContextInfo, `. Add after the `it("context_info", …)` line:

```ts
  it("kubeconfig_source", () => expect(isKubeconfigSource(kubeconfigSource)).toBe(true));
  it("rejects a kubeconfig source with an unknown state", () => expect(isKubeconfigSource({ ...kubeconfigSource, state: "broken" })).toBe(false));
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `cargo test --test ipc_fixtures kubeconfig_source` (in `src-tauri/`). Expected: PASS, because Tasks 1–2 already define the Rust type. Then run: `pnpm vitest run src/shared/ipc/fixtures.test.ts`. Expected: FAIL with `isKubeconfigSource is not a function` (or a TS import error).

- [ ] **Step 3: Implement.** In `src/shared/ipc/types.ts`, add after the `ConnectInfo` interface:

```ts
export const SOURCE_ORIGINS = ["env", "default", "added"] as const;
export const SOURCE_STATES = ["ok", "missing", "invalid", "empty"] as const;
/** One kubeconfig path Wiring reads, with what it held (see docs/ipc-contract.md#kubeconfig-sources). */
export interface KubeconfigSource {
  path: string;
  origin: (typeof SOURCE_ORIGINS)[number];
  state: (typeof SOURCE_STATES)[number];
  contexts: number;
  error: string | null;
}
```

and add after `isConnectInfo`:

```ts
export function isKubeconfigSource(v: unknown): v is KubeconfigSource {
  return isObj(v) && isStr(v.path) && oneOf(SOURCE_ORIGINS, v.origin) && oneOf(SOURCE_STATES, v.state)
    && typeof v.contexts === "number" && isStrOrNull(v.error);
}
```

In `src/shared/ipc/commands.ts`, add `KubeconfigSource` to the type import from `./types`, and add after the `addKubeconfig` line:

```ts
  kubeconfigSources: () => call<KubeconfigSource[]>("kubeconfig_sources"),
```

In `docs/ipc-contract.md`:

1. Replace the `add_kubeconfig` row with:

```markdown
| `add_kubeconfig` | `{ path }` | `ContextInfo[]` — rejects with `AppError` when the file is missing (`notFound`), unparseable (`internal`) or defines no contexts (`invalid`: "`<file name>` has no contexts"); a rejected file is not saved |
| `kubeconfig_sources` | — | `KubeconfigSource[]` — one per kubeconfig path, in load order (see [Kubeconfig sources](#kubeconfig-sources)) |
```

2. Replace the `connect` row with:

```markdown
| `connect` | `{ context }` | `ConnectInfo` — a **rejected promise** carries the `AppError`; no `connection_error` event is sent for connect failures. When the API server does not answer the version probe and the namespace list within 20 s, it rejects with `network` "timed out after 20 s waiting for `<server>`" |
```

3. Add this section before `## Settings file`:

```markdown
## Kubeconfig sources

`KubeconfigSource { path, origin, state, contexts, error }` describes one path the backend reads kubeconfig from:

| Field | Values |
|---|---|
| `origin` | `env` (an entry of `KUBECONFIG`), `default` (`~/.kube/config`, read only when `KUBECONFIG` is unset or empty), `added` (from `extraKubeconfigs`) |
| `state` | `ok` (parsed, `contexts` > 0), `missing` (no such file), `invalid` (unreadable or unparseable), `empty` (parsed, no contexts) |

`contexts` counts the file's own contexts, before the first-file-wins merge that `list_contexts` does. `error` is the first line of the read or parse error when `state` is `invalid`, and `null` otherwise.

On macOS and Linux the backend replaces its `PATH` at startup with the login shell's (`$SHELL -ilc`, 3 s timeout), keeping its own entries after it. When the shell does not answer, it appends the common tool directories that exist instead (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/google-cloud-sdk/bin`). This way kubeconfig exec plugins are found when the app is started from the Dock or a launcher.
```

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/shared/ipc/fixtures.test.ts && pnpm typecheck`. Expected: PASS, and `echo $?` prints `0`. Then run (in `src-tauri/`): `cargo test --test ipc_fixtures`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/shared/ipc src-tauri/tests/ipc_fixtures.rs docs/ipc-contract.md
git commit -m "Add kubeconfig sources to the IPC contract" -m "<trailers>"
```

---

### Task 6: Shared `EmptyState` component

**Files:**
- Create: `src/shared/EmptyState.tsx`, `src/shared/EmptyState.test.tsx`

- [ ] **Step 1: Write the failing test.** Create `src/shared/EmptyState.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("names its region by the title and runs its actions", () => {
    const create = vi.fn();
    const pick = vi.fn();
    render(
      <EmptyState icon={Inbox} title="Nothing here yet" primary={{ label: "+ Create", onClick: create }} secondary={{ label: "Pick another namespace", onClick: pick }}>
        shop has no resources.
      </EmptyState>,
    );
    expect(screen.getByRole("region", { name: "Nothing here yet" })).toHaveTextContent("shop has no resources.");
    fireEvent.click(screen.getByRole("button", { name: "+ Create" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick another namespace" }));
    expect(create).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledOnce();
  });

  it("has no buttons without actions", () => {
    render(<EmptyState icon={Inbox} title="Loading shop…" spinning />);
    expect(screen.getByRole("heading", { name: "Loading shop…" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to see it fail.** Run: `pnpm vitest run src/shared/EmptyState.test.tsx`. Expected: FAIL with `Failed to resolve import "./EmptyState"`.

- [ ] **Step 3: Implement.** Create `src/shared/EmptyState.tsx`:

```tsx
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/Button";

export interface EmptyAction { label: string; onClick: () => void }

/** A centre-pane state: an icon, what happened in a sentence or two, and up to two ways forward.
 *  `overlay` floats it over the graph, where only the card itself takes pointer events. */
export function EmptyState({ icon: Icon, title, children, primary, secondary, spinning = false, overlay = false }: {
  icon: LucideIcon; title: string; children?: ReactNode; primary?: EmptyAction; secondary?: EmptyAction; spinning?: boolean; overlay?: boolean;
}) {
  const outer = overlay
    ? "pointer-events-none absolute inset-0 grid place-items-center p-8"
    : "grid h-full w-full place-items-center bg-space px-8 py-6";
  return (
    <div className={outer}>
      <section aria-label={title} className="pointer-events-auto flex max-w-lg flex-col items-center gap-3 text-center">
        <Icon aria-hidden className={`size-8 text-accent ${spinning ? "animate-spin" : ""}`} />
        <h2 className="text-lg font-medium text-text-hi">{title}</h2>
        {children !== undefined && <div className="text-sm text-text-muted">{children}</div>}
        {(primary || secondary) && (
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            {primary && <Button variant="primary" onClick={primary.onClick}>{primary.label}</Button>}
            {secondary && <Button onClick={secondary.onClick}>{secondary.label}</Button>}
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to see it pass.** Run: `pnpm vitest run src/shared/EmptyState.test.tsx`. Expected: PASS (2 tests), and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/shared/EmptyState.tsx src/shared/EmptyState.test.tsx
git commit -m "Add a shared empty-state component" -m "<trailers>"
```

---

### Task 7: Store: connecting, last error, retry, kubeconfig sources, picker requests

**Files:**
- Modify: `src/app/store.ts`, `src/app/store.test.ts`
- Create: `src/app/store.onboarding.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `src/app/store.onboarding.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeconfigSource } from "../shared/ipc/types";

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));
vi.mock("../shared/settings", () => ({
  settings: {
    get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}),
    getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}),
  },
}));

import { invoke } from "../shared/ipc/tauri";
import { initialState, useAppStore } from "./store";

const INFO = { context: "prod", serverVersion: "v1.33.0", namespaces: ["default", "shop"], canListNamespaces: true };
const PROD = { name: "prod", cluster: "c", user: "u", namespace: "shop", sourceFile: "/k" };
const SOURCES: KubeconfigSource[] = [{ path: "/k", origin: "default", state: "ok", contexts: 1, error: null }];
const answer = (cmd: string): unknown => {
  if (cmd === "connect") return INFO;
  if (cmd === "list_contexts") return [PROD];
  if (cmd === "kubeconfig_sources") return SOURCES;
  if (cmd === "denied_kinds" || cmd === "partial_kinds") return [];
  return null;
};
const called = () => vi.mocked(invoke).mock.calls.map((c) => c[0]);

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => answer(cmd));
});

describe("connecting and the last error", () => {
  it("marks the context being dialled until connect settles", async () => {
    let resolve!: (v: typeof INFO) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((r) => { resolve = r as typeof resolve; }));
    const pending = useAppStore.getState().connect("prod");
    expect(useAppStore.getState().connection).toMatchObject({ connecting: "prod", busy: true, lastError: null });
    resolve(INFO);
    expect(await pending).toBe(true);
    expect(useAppStore.getState().connection).toMatchObject({ connecting: null, busy: false, context: "prod", lastError: null });
  });

  it("keeps a failed connect as the last error, and the next connect clears it", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "network", message: "timed out after 20 s waiting for https://k" });
    expect(await useAppStore.getState().connect("prod")).toBe(false);
    expect(useAppStore.getState().connection).toMatchObject({
      connecting: null, busy: false, context: null,
      lastError: { context: "prod", error: { kind: "network", message: "timed out after 20 s waiting for https://k" } },
    });
    expect(useAppStore.getState().toasts).toEqual([]);
    const pending = useAppStore.getState().connect("prod");
    expect(useAppStore.getState().connection.lastError).toBeNull();
    await pending;
  });

  it("disconnect clears the last error", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, lastError: { context: "prod", error: { kind: "auth", message: "no" } } } });
    await useAppStore.getState().disconnect();
    expect(useAppStore.getState().connection.lastError).toBeNull();
  });

  it("retryConnect reconnects the failed context and opens its namespace", async () => {
    useAppStore.setState({ contexts: [PROD], connection: { ...initialState().connection, lastError: { context: "prod", error: { kind: "auth", message: "no" } } } });
    await useAppStore.getState().retryConnect();
    expect(invoke).toHaveBeenCalledWith("connect", { context: "prod" });
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: ["shop"], expandedGroups: [] });
    expect(useAppStore.getState().connection).toMatchObject({ context: "prod", lastError: null });
  });

  it("dismissConnectError clears the error and opens a collapsed navigator", async () => {
    useAppStore.setState({ sidebarCollapsed: true, connection: { ...initialState().connection, lastError: { context: "prod", error: { kind: "auth", message: "no" } } } });
    await useAppStore.getState().dismissConnectError();
    expect(useAppStore.getState().connection.lastError).toBeNull();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });
});

describe("kubeconfig sources", () => {
  it("loads them, and keeps them across a connect and a disconnect", async () => {
    await useAppStore.getState().loadKubeconfigSources();
    expect(useAppStore.getState().kubeconfigSources).toEqual(SOURCES);
    await useAppStore.getState().connect("prod");
    expect(useAppStore.getState().kubeconfigSources).toEqual(SOURCES);
    await useAppStore.getState().disconnect();
    expect(useAppStore.getState().kubeconfigSources).toEqual(SOURCES);
  });

  it("treats a missing answer as no sources and toasts a failure", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await useAppStore.getState().loadKubeconfigSources();
    expect(useAppStore.getState().kubeconfigSources).toEqual([]);
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "internal", message: "boom" });
    await useAppStore.getState().loadKubeconfigSources();
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "internal", message: "boom" });
  });

  it("rescan re-reads the contexts and the sources", async () => {
    await useAppStore.getState().rescanKubeconfigs();
    expect(called()).toEqual(expect.arrayContaining(["list_contexts", "kubeconfig_sources"]));
    expect(useAppStore.getState().contexts).toEqual([PROD]);
    expect(useAppStore.getState().kubeconfigSources).toEqual(SOURCES);
  });
});

describe("empty-state actions", () => {
  it("openNamespacePicker bumps the request counter", () => {
    const before = useAppStore.getState().namespacePickerSeq;
    useAppStore.getState().openNamespacePicker();
    expect(useAppStore.getState().namespacePickerSeq).toBe(before + 1);
  });

  it("showAllKinds turns every chip on", () => {
    expect(useAppStore.getState().hiddenKinds.size).toBeGreaterThan(0);
    useAppStore.getState().showAllKinds();
    expect(useAppStore.getState().hiddenKinds.size).toBe(0);
  });
});
```

In `src/app/store.test.ts`, replace the whole `it("connect failure becomes a toast and leaves the app disconnected", …)` block with:

```ts
  it("connect failure is kept as the last error and leaves the app disconnected, without a toast", async () => {
    // The backend tears the previous session down before dialling the new context, so a failed
    // connect from a connected state must not pretend the old connection is still alive.
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }),
      connection: { ...initialState().connection, state: "connected", context: "staging", scope: ["payments"] },
      toasts: [{ id: 1, kind: "info", message: "earlier" }],
    });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "auth", message: "exec plugin missing" });
    expect(await useAppStore.getState().connect("prod")).toBe(false);
    const s = useAppStore.getState();
    expect(s.connection).toEqual({ ...initialState().connection, lastError: { context: "prod", error: { kind: "auth", message: "exec plugin missing" } } });
    expect(s.nodes.size).toBe(0);
    expect(s.toasts).toEqual([{ id: 1, kind: "info", message: "earlier" }]);
  });
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/app/store.onboarding.test.ts src/app/store.test.ts`. Expected: FAIL. `connecting` and `lastError` are undefined, `retryConnect`, `loadKubeconfigSources`, `rescanKubeconfigs`, `openNamespacePicker`, `showAllKinds` and `dismissConnectError` are not functions, and the rewritten store test finds a toast.

- [ ] **Step 3: Implement.** In `src/app/store.ts`:

1. Add `KubeconfigSource` to the type import from `../shared/ipc/types`, and add the import:

```ts
import { connectContext } from "../features/cluster/connectContext";
```

`connectContext.ts` imports the store too. That is safe because neither module uses the other at load time, only inside functions.

2. In `interface Connection`, add after `busy: boolean;`:

```ts
  /** The context a connect is dialling (the header and the centre pane say so); `null` otherwise. */
  connecting: string | null;
  /** The last failed connect, shown by the centre pane until the next connect or a disconnect. */
  lastError: { context: string; error: AppError } | null;
```

3. In `interface AppState`, add after `contexts: ContextInfo[];`:

```ts
  /** What each kubeconfig path held at the last scan; `null` until scanned. */
  kubeconfigSources: KubeconfigSource[] | null;
  /** Bumped by `openNamespacePicker`; the header's picker opens on every change. */
  namespacePickerSeq: number;
```

and add after `loadContexts: () => Promise<void>;`:

```ts
  loadKubeconfigSources: () => Promise<void>;
  /** Re-read the contexts and the kubeconfig sources (the welcome pane's Rescan). */
  rescanKubeconfigs: () => Promise<void>;
  /** Connect again to the context of the last failed connect, reopening its scope. */
  retryConnect: () => Promise<void>;
  /** Leave the failure pane for the cluster list ("Choose another cluster"). */
  dismissConnectError: () => Promise<void>;
  /** Ask the header's namespace picker to open (an empty state's "Choose a namespace"). */
  openNamespacePicker: () => void;
  /** Turn every kind chip on. */
  showAllKinds: () => void;
```

4. In `initialState()`, replace the `connection:` line with:

```ts
    connection: { state: "disconnected", context: null, serverVersion: null, namespaces: [], canListNamespaces: true, scope: null, busy: false, connecting: null, lastError: null },
```

and add after `contexts: [],`:

```ts
    kubeconfigSources: null,
    namespacePickerSeq: 0,
```

5. In `disconnectedState`, replace `pickerOpen: s.contexts.length === 0, sidebarCollapsed: s.sidebarCollapsed,` with:

```ts
    pickerOpen: s.contexts.length === 0, sidebarCollapsed: s.sidebarCollapsed, kubeconfigSources: s.kubeconfigSources,
```

6. In the `Actions` type, replace `| "applySnapshot" | "applyDelta" | "setObjectEvents" | "setConnectionState" | "loadContexts" | "addKubeconfig" | "connect"` with:

```ts
  | "applySnapshot" | "applyDelta" | "setObjectEvents" | "setConnectionState" | "loadContexts" | "addKubeconfig" | "connect"
  | "loadKubeconfigSources" | "rescanKubeconfigs" | "retryConnect" | "dismissConnectError" | "openNamespacePicker" | "showAllKinds"
```

7. Replace the `connect: async (context) => { … },` action with:

```ts
  connect: async (context) => {
    const lost = lostEditsToast(get());
    customKindsGen++; // a custom kinds load of the session being replaced must not land in the next
    set((s) => ({ connection: { ...s.connection, busy: true, connecting: context, lastError: null } }));
    try {
      const info = await commands.connect(context);
      set({
        ...initialState(),
        contexts: get().contexts,
        kubeconfigSources: get().kubeconfigSources,
        hiddenKinds: get().hiddenKinds,
        sidebarCollapsed: get().sidebarCollapsed,
        connection: {
          state: "connected", context: info.context, serverVersion: info.serverVersion, namespaces: info.namespaces,
          canListNamespaces: info.canListNamespaces, scope: null, busy: false, connecting: null, lastError: null,
        },
      });
      if (lost) get().toast(lost);
      return true;
    } catch (e) {
      // The backend tears the previous session down before dialling, so a failed connect leaves
      // the app disconnected whatever it was before. The centre pane shows the error; no toast.
      const base = disconnectedState(get());
      set({ ...base, connection: { ...base.connection, lastError: { context, error: toAppError(e) } } });
      return false;
    }
  },
```

8. Add after the `loadContexts` action:

```ts
  loadKubeconfigSources: async () => {
    try {
      // `?? []`: an answer without a list still counts as scanned.
      set({ kubeconfigSources: (await commands.kubeconfigSources()) ?? [] });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  rescanKubeconfigs: async () => {
    await get().loadContexts();
    await get().loadKubeconfigSources();
  },

  retryConnect: async () => {
    const last = get().connection.lastError;
    if (last) await connectContext(last.context);
  },

  dismissConnectError: async () => {
    set((s) => ({ connection: { ...s.connection, lastError: null } }));
    if (get().sidebarCollapsed) await get().toggleSidebar();
  },

  openNamespacePicker: () => set((s) => ({ namespacePickerSeq: s.namespacePickerSeq + 1 })),

  showAllKinds: () => set({ hiddenKinds: new Set() }),
```

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/app && pnpm typecheck`. Expected: PASS (every file under `src/app`), typecheck clean, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/app/store.ts src/app/store.test.ts src/app/store.onboarding.test.ts
git commit -m "Track the connecting context, the last connect error and kubeconfig sources" -m "<trailers>"
```

---

### Task 8: `describeConnectError`

**Files:**
- Create: `src/features/onboarding/describeConnectError.ts`, `src/features/onboarding/describeConnectError.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `src/features/onboarding/describeConnectError.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AppError } from "../../shared/ipc/types";
import { describeConnectError } from "./describeConnectError";

const RESTART = "Wiring uses your login shell's PATH; restart Wiring after installing it.";
const err = (kind: AppError["kind"], message: string): AppError => ({ kind, message });
const missing = (plugin: string) => err("auth", `unable to run auth exec: No such file or directory (os error 2) (exec plugin: ${plugin})`);

describe("describeConnectError", () => {
  it("names a missing login helper, by its file name, with how to install it", () => {
    const m = missing("/usr/local/bin/gke-gcloud-auth-plugin");
    expect(describeConnectError(m)).toEqual({
      cause: "helper",
      title: "The gke-gcloud-auth-plugin login helper isn't installed",
      detail: m.message,
      hint: `Install it with: gcloud components install gke-gcloud-auth-plugin. ${RESTART}`,
    });
  });

  it.each([
    ["aws", "Install the AWS CLI."],
    ["kubelogin", "Install it with: brew install Azure/kubelogin/kubelogin."],
    ["tsh", "Install tsh and make sure it is on your PATH."],
  ])("gives an install hint for %s", (plugin, install) => {
    expect(describeConnectError(missing(plugin)).hint).toBe(`${install} ${RESTART}`);
  });

  it("treats other auth failures as rejected credentials, with or without a plugin", () => {
    for (const e of [err("auth", "Unauthorized (exec plugin: aws)"), err("auth", "Unauthorized")]) {
      expect(describeConnectError(e)).toMatchObject({
        cause: "credentials", title: "Your credentials were rejected", hint: "Log in again with your provider's CLI, then Retry.",
      });
    }
  });

  it("recognises an untrusted certificate", () => {
    for (const e of [err("network", "error trying to connect: invalid peer certificate: UnknownIssuer"), err("internal", "x509: certificate signed by unknown authority")]) {
      expect(describeConnectError(e)).toMatchObject({
        cause: "certificate", title: "The cluster's certificate isn't trusted", hint: "Check the cluster's CA in your kubeconfig.",
      });
    }
  });

  it("recognises a timeout before certificate words in the server name", () => {
    expect(describeConnectError(err("network", "timed out after 20 s waiting for https://ssl.example.com"))).toMatchObject({
      cause: "timeout", title: "Connection timed out", hint: "Check your VPN or network.",
    });
  });

  it("calls any other network error unreachable", () => {
    expect(describeConnectError(err("network", "error trying to connect: tcp connect error: Connection refused (os error 61)"))).toMatchObject({
      cause: "unreachable", title: "Can't reach the cluster", hint: "Check your VPN or network.",
    });
  });

  it("falls back to the message alone", () => {
    expect(describeConnectError(err("notFound", 'context "x" not found'))).toEqual({
      cause: "other", title: "Couldn't connect", detail: 'context "x" not found', hint: null,
    });
  });

  it("keeps only the first line of the server's message", () => {
    expect(describeConnectError(err("network", "refused\nsecond line")).detail).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/features/onboarding/describeConnectError.test.ts`. Expected: FAIL with `Failed to resolve import "./describeConnectError"`.

- [ ] **Step 3: Implement.** Create `src/features/onboarding/describeConnectError.ts`:

```ts
import type { AppError } from "../../shared/ipc/types";

export type ConnectCause = "helper" | "credentials" | "certificate" | "timeout" | "unreachable" | "other";

/** A failed connect in words: the title of the failure pane, the server's first line, a next step. */
export interface ConnectErrorInfo { cause: ConnectCause; title: string; detail: string; hint: string | null }

/** The backend appends this to every `auth` error of a context with an exec plugin. */
const PLUGIN = /\(exec plugin: ([^)]+)\)/;
/** kube could not start the plugin at all (as opposed to the server refusing its token). */
const NOT_STARTED = /unable to run auth exec|no such file|not found|cannot find|os error 2/i;
const CERTIFICATE = /certificate|x509|tls|ssl|unknownissuer/i;
const TIMED_OUT = /timed out/i;
const RESTART = "Wiring uses your login shell's PATH; restart Wiring after installing it.";
const NETWORK_HINT = "Check your VPN or network.";
const INSTALL: Record<string, string> = {
  "gke-gcloud-auth-plugin": "Install it with: gcloud components install gke-gcloud-auth-plugin.",
  aws: "Install the AWS CLI.",
  kubelogin: "Install it with: brew install Azure/kubelogin/kubelogin.",
};

const firstLine = (s: string) => s.split("\n", 1)[0].trim();

/** Why `connect` failed, classified from the `AppError` alone (pure). */
export function describeConnectError(error: AppError): ConnectErrorInfo {
  const detail = firstLine(error.message);
  if (error.kind === "auth") {
    const plugin = PLUGIN.exec(error.message)?.[1].trim();
    if (plugin && NOT_STARTED.test(error.message)) {
      const name = plugin.split(/[\\/]/).pop() || plugin;
      const install = INSTALL[name] ?? `Install ${name} and make sure it is on your PATH.`;
      return { cause: "helper", title: `The ${name} login helper isn't installed`, detail, hint: `${install} ${RESTART}` };
    }
    return { cause: "credentials", title: "Your credentials were rejected", detail, hint: "Log in again with your provider's CLI, then Retry." };
  }
  if (error.kind === "network" && TIMED_OUT.test(error.message)) {
    return { cause: "timeout", title: "Connection timed out", detail, hint: NETWORK_HINT };
  }
  if ((error.kind === "network" || error.kind === "internal") && CERTIFICATE.test(error.message)) {
    return { cause: "certificate", title: "The cluster's certificate isn't trusted", detail, hint: "Check the cluster's CA in your kubeconfig." };
  }
  if (error.kind === "network") return { cause: "unreachable", title: "Can't reach the cluster", detail, hint: NETWORK_HINT };
  return { cause: "other", title: "Couldn't connect", detail, hint: null };
}
```

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/features/onboarding/describeConnectError.test.ts`. Expected: PASS (10 tests), and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/features/onboarding/describeConnectError.ts src/features/onboarding/describeConnectError.test.ts
git commit -m "Classify connect errors into causes with a next step" -m "<trailers>"
```

---

### Task 9: Graph empty states

**Files:**
- Create: `src/features/graph/graphEmptyState.ts`, `src/features/graph/graphEmptyState.test.ts`, `src/features/graph/GraphEmpty.tsx`
- Modify: `src/features/graph/toFlow.ts`, `src/features/graph/Canvas.tsx`, `src/features/graph/Canvas.test.tsx`

- [ ] **Step 1: Write the failing tests.** Create `src/features/graph/graphEmptyState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { GraphNode, Kind } from "../../shared/ipc/types";
import { graphEmptyState, NAMESPACED_KINDS, type GraphEmptyInput } from "./graphEmptyState";

const n = (name: string, kind: Kind = "Pod"): GraphNode => ({ id: `${kind}/shop/${name}`, kind, namespace: "shop", name, status: "ok", badges: [], group: null });
const input = (over: Partial<GraphEmptyInput> = {}): GraphEmptyInput => ({
  context: "prod", scope: ["shop"], namespaces: ["shop"], canListNamespaces: true, graphReady: true, tooLarge: null,
  deniedKinds: new Set(), nodes: new Map([["Pod/shop/web", n("web")]]), hiddenKinds: new Set(), search: "", ...over,
});
const allDenied = new Set<Kind>(NAMESPACED_KINDS);

describe("graphEmptyState", () => {
  it("leaves a missing connection to the connection pane", () => {
    expect(graphEmptyState(input({ context: null, scope: null }))).toBeNull();
  });

  it("asks for a namespace first, saying when namespaces cannot be listed", () => {
    expect(graphEmptyState(input({ scope: null }))).toEqual({ type: "noNamespace", canListNamespaces: true });
    expect(graphEmptyState(input({ scope: null, canListNamespaces: false }))).toEqual({ type: "noNamespace", canListNamespaces: false });
  });

  it("is loading until the scope's snapshot arrives", () => {
    expect(graphEmptyState(input({ graphReady: false, tooLarge: { nodes: 2000, kinds: [] } }))).toEqual({ type: "loading", scope: "shop" });
  });

  it("puts too large before no access", () => {
    expect(graphEmptyState(input({ tooLarge: { nodes: 1873, kinds: [] }, deniedKinds: allDenied, nodes: new Map() })))
      .toEqual({ type: "tooLarge", count: 1873, scope: "shop" });
  });

  it("says no access when every namespaced kind is denied, before empty", () => {
    expect(graphEmptyState(input({ deniedKinds: allDenied, nodes: new Map() }))).toEqual({ type: "noAccess", scope: "shop" });
    expect(NAMESPACED_KINDS).not.toContain("Node");
    // One readable kind is enough to call it merely empty.
    const someDenied = new Set<Kind>(NAMESPACED_KINDS.filter((k) => k !== "ConfigMap"));
    expect(graphEmptyState(input({ deniedKinds: someDenied, nodes: new Map() }))).toEqual({ type: "empty", scope: "shop" });
  });

  it("labels several namespaces like the header", () => {
    expect(graphEmptyState(input({ scope: ["shop", "blog"], nodes: new Map() }))).toEqual({ type: "empty", scope: "shop, blog" });
  });

  it("says all kinds are hidden before search misses", () => {
    expect(graphEmptyState(input({ hiddenKinds: new Set(["Pod"]), search: "zzz" }))).toEqual({ type: "allHidden" });
  });

  it("says nothing matches a search", () => {
    expect(graphEmptyState(input({ search: "  zzz " }))).toEqual({ type: "noMatch", query: "zzz" });
    expect(graphEmptyState(input({ search: "web" }))).toBeNull();
    expect(graphEmptyState(input({ search: "shop/we" }))).toBeNull();
  });

  it("has nothing to say about a graph with visible nodes", () => {
    expect(graphEmptyState(input())).toBeNull();
  });
});
```

In `src/features/graph/Canvas.test.tsx`, add `import { NAMESPACED_KINDS } from "./graphEmptyState";` after the `Canvas` import. Then replace the first three tests (`shows the empty state before a namespace is selected`, `shows the loading state…`, `shows the empty-namespace state…`) with:

```tsx
  it("asks for a namespace before one is selected, and the button opens the picker", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" } });
    render(<Canvas />);
    expect(screen.getByRole("region", { name: "Choose a namespace" })).toHaveTextContent("Pick one or more namespaces to see their resources.");
    fireEvent.click(screen.getByRole("button", { name: "Choose a namespace" }));
    expect(useAppStore.getState().namespacePickerSeq).toBe(1);
  });

  it("shows the loading state after selecting a namespace until the snapshot arrives", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["payments"] } });
    render(<Canvas />);
    expect(screen.getByText(/loading payments/i)).toBeInTheDocument();
  });

  it("shows the empty-namespace state for an empty snapshot, with + Create", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["payments"] },
    });
    render(<Canvas />);
    expect(screen.getByRole("region", { name: "Nothing here yet" })).toHaveTextContent("payments has no resources.");
    fireEvent.click(screen.getByRole("button", { name: "+ Create" }));
    expect(useAppStore.getState().createDialog.open).toBe(true);
  });

  it("says no access when every namespaced kind is denied", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [], edges: [] }), deniedKinds: new Set(NAMESPACED_KINDS),
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["payments"] },
    });
    render(<Canvas />);
    expect(screen.getByRole("region", { name: "No access" })).toHaveTextContent("You can't list any resources in payments (RBAC).");
  });

  it("offers Show all kinds when the chips hide every kind", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [{ id: "Role/p/reader", kind: "Role", namespace: "p", name: "reader", status: "ok", badges: [], group: null }], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["p"] },
    });
    render(<Canvas />);
    fireEvent.click(screen.getByRole("button", { name: "Show all kinds" }));
    expect(useAppStore.getState().hiddenKinds.size).toBe(0);
  });

  it("offers Clear search when nothing matches", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [{ id: "Pod/p/web-1", kind: "Pod", namespace: "p", name: "web-1", status: "ok", badges: [], group: null }], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["p"] }, search: "zzz",
    });
    render(<Canvas />);
    expect(screen.getByRole("region", { name: "No matches" })).toHaveTextContent("Nothing on the graph matches “zzz”.");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(useAppStore.getState().search).toBe("");
  });
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/features/graph/graphEmptyState.test.ts src/features/graph/Canvas.test.tsx`. Expected: FAIL with `Failed to resolve import "./graphEmptyState"`.

- [ ] **Step 3: Implement.** In `src/features/graph/toFlow.ts`, add before `export function toFlow`:

```ts
/** The nodes the kind chips let through. */
export function visibleNodes(nodes: Map<NodeId, GraphNode>, hiddenKinds: Set<Kind>): GraphNode[] {
  return [...nodes.values()].filter((n) => !hiddenKinds.has(n.kind));
}

/** Whether `n` matches the header search: its kind, or its name alone or as `namespace/name` (the
 *  namespace counts too, alone or as `blog/web`). An empty search matches everything. */
export function matchesSearch(n: GraphNode, search: string): boolean {
  const q = search.trim().toLowerCase();
  return q === "" || n.kind.toLowerCase().includes(q)
    || (n.namespace === null ? n.name : `${n.namespace}/${n.name}`).toLowerCase().includes(q);
}
```

In `toFlow`, replace the line `const visible = [...input.nodes.values()].filter((n) => !input.hiddenKinds.has(n.kind));` with:

```ts
  const visible = visibleNodes(input.nodes, input.hiddenKinds);
```

and replace the four lines from `const q = input.search.trim().toLowerCase();` through the `matches` definition (the comment line and the two-line arrow function) with:

```ts
  const matches = (n: GraphNode) => matchesSearch(n, input.search);
```

Create `src/features/graph/graphEmptyState.ts`:

```ts
import { KINDS, type GraphNode, type Kind, type NamespaceScope, type NodeId, type TooLarge } from "../../shared/ipc/types";
import { scopeLabel } from "../../shared/scope";
import { matchesSearch, visibleNodes } from "./toFlow";

/** Cluster-scoped kinds (their RBAC does not depend on the scope) and the synthetic ones. */
const NOT_NAMESPACED = new Set<Kind>(["PersistentVolume", "ClusterRole", "ClusterRoleBinding", "Node", "PodGroup", "Custom"]);
/** The watched kinds a namespace's RBAC decides about. */
export const NAMESPACED_KINDS: Kind[] = KINDS.filter((k) => !NOT_NAMESPACED.has(k));

/** The "Choose a namespace" sentence, shared by the graph and the tables. */
export function noNamespaceBody(canListNamespaces: boolean): string {
  return canListNamespaces
    ? "Pick one or more namespaces to see their resources."
    : "You can't list namespaces on this cluster. Type the name of one you have access to.";
}

export type GraphSituation =
  | { type: "noNamespace"; canListNamespaces: boolean }
  | { type: "loading"; scope: string }
  | { type: "tooLarge"; count: number; scope: string }
  | { type: "noAccess"; scope: string }
  | { type: "empty"; scope: string }
  | { type: "allHidden" }
  | { type: "noMatch"; query: string };

export interface GraphEmptyInput {
  context: string | null;
  scope: NamespaceScope | null;
  namespaces: string[];
  canListNamespaces: boolean;
  graphReady: boolean;
  tooLarge: TooLarge | null;
  deniedKinds: Set<Kind>;
  nodes: Map<NodeId, GraphNode>;
  hiddenKinds: Set<Kind>;
  search: string;
}

/** Why the graph has nothing to draw, in priority order, or `null` when it has something. Not
 *  connected, connecting and a failed connect belong to the connection pane (`connectionPane`),
 *  which replaces the views, so this starts at a connected session. */
export function graphEmptyState(i: GraphEmptyInput): GraphSituation | null {
  if (i.context === null) return null;
  if (i.scope === null) return { type: "noNamespace", canListNamespaces: i.canListNamespaces };
  const scope = scopeLabel(i.scope, i.namespaces) ?? "";
  if (!i.graphReady) return { type: "loading", scope };
  if (i.tooLarge) return { type: "tooLarge", count: i.tooLarge.nodes, scope };
  if (NAMESPACED_KINDS.every((k) => i.deniedKinds.has(k))) return { type: "noAccess", scope };
  if (i.nodes.size === 0) return { type: "empty", scope };
  const visible = visibleNodes(i.nodes, i.hiddenKinds);
  if (visible.length === 0) return { type: "allHidden" };
  const query = i.search.trim();
  if (query !== "" && !visible.some((n) => matchesSearch(n, query))) return { type: "noMatch", query };
  return null;
}
```

Create `src/features/graph/GraphEmpty.tsx`:

```tsx
import { EyeOff, Inbox, Layers, LoaderCircle, Network, SearchX, ShieldOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { EmptyState } from "../../shared/EmptyState";
import { noNamespaceBody, type GraphSituation } from "./graphEmptyState";

/** The graph's empty state, floated over the (empty) canvas. */
export function GraphEmpty({ state }: { state: GraphSituation }) {
  const a = useAppStore(useShallow((s) => ({
    openNamespacePicker: s.openNamespacePicker, openCreate: s.openCreate, showAllKinds: s.showAllKinds,
    setSearch: s.setSearch, showTable: s.showTable, lastTableKind: s.lastTableKind,
  })));
  const pick = (label: string) => ({ label, onClick: a.openNamespacePicker });
  switch (state.type) {
    case "noNamespace":
      return <EmptyState overlay icon={Layers} title="Choose a namespace" primary={pick("Choose a namespace")}>{noNamespaceBody(state.canListNamespaces)}</EmptyState>;
    case "loading":
      return <EmptyState overlay spinning icon={LoaderCircle} title={`Loading ${state.scope}…`} />;
    case "tooLarge":
      return (
        <EmptyState overlay icon={Network} title="Too many objects to draw" primary={pick("Pick fewer namespaces")}
          secondary={{ label: "Open tables", onClick: () => void a.showTable(a.lastTableKind ?? "Deployment") }}>
          {`${state.count.toLocaleString("en-US")} objects in ${state.scope}. Use the tables, or pick fewer namespaces.`}
        </EmptyState>
      );
    case "noAccess":
      return (
        <EmptyState overlay icon={ShieldOff} title="No access" primary={pick("Pick another namespace")}>
          {`You can't list any resources in ${state.scope} (RBAC). Ask your cluster admin, or pick another namespace.`}
        </EmptyState>
      );
    case "empty":
      return (
        <EmptyState overlay icon={Inbox} title="Nothing here yet" primary={{ label: "+ Create", onClick: () => a.openCreate() }} secondary={pick("Pick another namespace")}>
          {`${state.scope} has no resources.`}
        </EmptyState>
      );
    case "allHidden":
      return <EmptyState overlay icon={EyeOff} title="All kinds are hidden" primary={{ label: "Show all kinds", onClick: a.showAllKinds }}>Turn some kinds back on to see the graph.</EmptyState>;
    case "noMatch":
      return (
        <EmptyState overlay icon={SearchX} title="No matches" primary={{ label: "Clear search", onClick: () => a.setSearch("") }}>
          {`Nothing on the graph matches “${state.query}”.`}
        </EmptyState>
      );
  }
}
```

In `src/features/graph/Canvas.tsx`:

1. Replace `import { isMulti, scopeLabel } from "../../shared/scope";` with:

```ts
import { GraphEmpty } from "./GraphEmpty";
import { graphEmptyState } from "./graphEmptyState";
```

2. In the `useShallow` selector, replace `nodes: s.nodes, edges: s.edges, tooLarge: s.tooLarge, graphReady: s.graphReady, hiddenKinds: s.hiddenKinds,` with:

```ts
      nodes: s.nodes, edges: s.edges, tooLarge: s.tooLarge, graphReady: s.graphReady, hiddenKinds: s.hiddenKinds, deniedKinds: s.deniedKinds,
      canListNamespaces: s.connection.canListNamespaces,
```

3. Replace the `let overlay: string | null = null;` line and the five `if`/`else if` lines after it with:

```ts
  const empty = graphEmptyState(s);
```

4. Replace the JSX block

```tsx
      {overlay && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-text-muted">{overlay}</div>
      )}
```

with:

```tsx
      {empty && <GraphEmpty state={empty} />}
```

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/features/graph && pnpm typecheck`. Expected: PASS (every graph test, including `toFlow.test.ts` unchanged), typecheck clean, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/features/graph
git commit -m "Explain an empty graph and offer the next step" -m "<trailers>"
```

---

### Task 10: Connection pane: welcome, choose, connecting, failure

**Files:**
- Create: `src/features/onboarding/panes.ts`, `src/features/onboarding/ConnectionPane.tsx`, `src/features/onboarding/ConnectionPane.test.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing tests.** Create `src/features/onboarding/ConnectionPane.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import type { AppError, KubeconfigSource } from "../../shared/ipc/types";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/team.yaml") }));
vi.mock("../../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
}));

import { invoke } from "../../shared/ipc/tauri";
import { ConnectionPane } from "./ConnectionPane";
import { connectionPane } from "./panes";

const SOURCES: KubeconfigSource[] = [
  { path: "/Users/me/.kube/config", origin: "default", state: "missing", contexts: 0, error: null },
  { path: "/Users/me/broken.yaml", origin: "added", state: "invalid", contexts: 0, error: "did not find expected key" },
];
const INFO = { context: "gke-prod", serverVersion: "v1.33.0", namespaces: ["shop"], canListNamespaces: true };
const HELPER: AppError = { kind: "auth", message: "unable to run auth exec: No such file or directory (os error 2) (exec plugin: gke-gcloud-auth-plugin)" };
const called = () => vi.mocked(invoke).mock.calls.map((c) => c[0]);

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "kubeconfig_sources") return SOURCES;
    if (cmd === "list_contexts" || cmd === "add_kubeconfig") return [];
    if (cmd === "connect") return INFO;
    if (cmd === "denied_kinds" || cmd === "partial_kinds") return [];
    return null;
  });
});

describe("connectionPane", () => {
  const c = initialState().connection;
  it("picks the pane in priority order", () => {
    const error = { context: "a", error: HELPER };
    expect(connectionPane({ ...c, connecting: "b", context: "a", lastError: error }, 2)).toEqual({ type: "connecting", context: "b" });
    expect(connectionPane({ ...c, context: "a" }, 2)).toBeNull();
    expect(connectionPane({ ...c, lastError: error }, 2)).toEqual({ type: "failed", context: "a", error: HELPER });
    expect(connectionPane(c, 0)).toEqual({ type: "welcome" });
    expect(connectionPane(c, 3)).toEqual({ type: "choose", contexts: 3 });
  });
});

describe("welcome pane", () => {
  it("lists every kubeconfig location Wiring read, with what it found", async () => {
    render(<ConnectionPane pane={{ type: "welcome" }} />);
    expect(screen.getByRole("region", { name: "Connect Wiring to a cluster" })).toBeInTheDocument();
    expect(await screen.findByText("/Users/me/.kube/config")).toBeInTheDocument();
    expect(screen.getByText("default location · not found")).toBeInTheDocument();
    expect(screen.getByText("added in Wiring · can't be read: did not find expected key")).toBeInTheDocument();
  });

  it("Add kubeconfig… and Rescan call the backend", async () => {
    useAppStore.setState({ kubeconfigSources: SOURCES });
    render(<ConnectionPane pane={{ type: "welcome" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add kubeconfig…" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("add_kubeconfig", { path: "/tmp/team.yaml" }));
    vi.mocked(invoke).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(called()).toEqual(expect.arrayContaining(["list_contexts", "kubeconfig_sources"])));
  });
});

describe("other panes", () => {
  it("points to the navigator when there are contexts but no connection", () => {
    render(<ConnectionPane pane={{ type: "choose", contexts: 2 }} />);
    expect(screen.getByRole("region", { name: "Choose a cluster" })).toHaveTextContent("Pick one of your 2 kubeconfig contexts in the navigator.");
  });

  it("says which context it is connecting to", () => {
    render(<ConnectionPane pane={{ type: "connecting", context: "prod" }} />);
    expect(screen.getByRole("region", { name: "Connecting to prod…" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("failure pane", () => {
  const fail = () => useAppStore.setState({
    contexts: [{ name: "gke-prod", cluster: "c", user: "u", namespace: "shop", sourceFile: "/k" }],
    connection: { ...initialState().connection, lastError: { context: "gke-prod", error: HELPER } },
  });

  it("shows the cause, the server's message and the hint; Retry reconnects", async () => {
    fail();
    render(<ConnectionPane pane={{ type: "failed", context: "gke-prod", error: HELPER }} />);
    const region = screen.getByRole("region", { name: "The gke-gcloud-auth-plugin login helper isn't installed" });
    expect(region).toHaveTextContent("unable to run auth exec");
    expect(region).toHaveTextContent("gcloud components install gke-gcloud-auth-plugin");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("connect", { context: "gke-prod" }));
    await waitFor(() => expect(useAppStore.getState().connection.context).toBe("gke-prod"));
  });

  it("Choose another cluster leaves the failure behind", async () => {
    fail();
    render(<ConnectionPane pane={{ type: "failed", context: "gke-prod", error: HELPER }} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose another cluster" }));
    await waitFor(() => expect(useAppStore.getState().connection.lastError).toBeNull());
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/features/onboarding/ConnectionPane.test.tsx`. Expected: FAIL with `Failed to resolve import "./ConnectionPane"`.

- [ ] **Step 3: Implement.** Create `src/features/onboarding/panes.ts`:

```ts
import type { Connection } from "../../app/store";
import type { AppError } from "../../shared/ipc/types";

/** What the centre pane shows instead of the views while there is no session to show. */
export type Pane =
  | { type: "connecting"; context: string }
  | { type: "failed"; context: string; error: AppError }
  | { type: "welcome" }
  | { type: "choose"; contexts: number };

/** The pane for this connection, or `null` when a session is up (the views take over). A connect
 *  in flight wins, even over a session it is replacing; then a failed connect; then, with no
 *  contexts at all, the welcome pane, else the pointer to the navigator. */
export function connectionPane(c: Pick<Connection, "context" | "connecting" | "lastError">, contexts: number): Pane | null {
  if (c.connecting !== null) return { type: "connecting", context: c.connecting };
  if (c.context !== null) return null;
  if (c.lastError) return { type: "failed", context: c.lastError.context, error: c.lastError.error };
  return contexts === 0 ? { type: "welcome" } : { type: "choose", contexts };
}
```

Create `src/features/onboarding/ConnectionPane.tsx`:

```tsx
import { CircleAlert, Clock, KeyRound, LoaderCircle, Network, ShieldAlert, Unplug, WifiOff, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { EmptyState } from "../../shared/EmptyState";
import type { AppError, KubeconfigSource } from "../../shared/ipc/types";
import { useAddKubeconfig } from "../cluster/useAddKubeconfig";
import { describeConnectError, type ConnectCause } from "./describeConnectError";
import type { Pane } from "./panes";

const CAUSE_ICON: Record<ConnectCause, LucideIcon> = {
  helper: KeyRound, credentials: ShieldAlert, certificate: ShieldAlert, timeout: Clock, unreachable: WifiOff, other: CircleAlert,
};
const ORIGIN_LABEL: Record<KubeconfigSource["origin"], string> = { env: "from KUBECONFIG", default: "default location", added: "added in Wiring" };

function sourceStateText(s: KubeconfigSource): string {
  switch (s.state) {
    case "ok": return `${s.contexts} ${s.contexts === 1 ? "context" : "contexts"}`;
    case "missing": return "not found";
    case "invalid": return `can't be read: ${s.error ?? "unknown error"}`;
    case "empty": return "no contexts";
  }
}

/** The centre pane while there is no connected session: welcome, choose, connecting or failed. */
export function ConnectionPane({ pane }: { pane: Pane }) {
  switch (pane.type) {
    case "connecting":
      return <EmptyState icon={LoaderCircle} spinning title={`Connecting to ${pane.context}…`}>Waiting for the cluster to answer (up to 20 seconds).</EmptyState>;
    case "failed":
      return <FailurePane context={pane.context} error={pane.error} />;
    case "welcome":
      return <WelcomePane />;
    case "choose":
      return <ChoosePane count={pane.contexts} />;
  }
}

function WelcomePane() {
  const { sources, loadKubeconfigSources, rescanKubeconfigs } = useAppStore(useShallow((s) => ({
    sources: s.kubeconfigSources, loadKubeconfigSources: s.loadKubeconfigSources, rescanKubeconfigs: s.rescanKubeconfigs,
  })));
  const add = useAddKubeconfig();
  useEffect(() => {
    if (sources === null) void loadKubeconfigSources();
  }, [sources, loadKubeconfigSources]);
  return (
    <EmptyState icon={Unplug} title="Connect Wiring to a cluster"
      primary={{ label: "Add kubeconfig…", onClick: () => void add() }} secondary={{ label: "Rescan", onClick: () => void rescanKubeconfigs() }}>
      <p>Wiring reads your kubeconfig, the file <code>kubectl</code> uses. It found no contexts in:</p>
      <ul aria-label="Kubeconfig files" className="mt-3 flex flex-col gap-1.5 text-left">
        {(sources ?? []).map((s, i) => (
          <li key={`${i}:${s.path}`} className="rounded-lg border border-border bg-surface px-3 py-2">
            <div className="selectable truncate font-mono text-xs text-text-hi" title={s.path}>{s.path}</div>
            <div className="text-xs">{`${ORIGIN_LABEL[s.origin]} · ${sourceStateText(s)}`}</div>
          </li>
        ))}
        {sources?.length === 0 && <li className="text-xs">No kubeconfig location: KUBECONFIG is empty and there is no home folder.</li>}
      </ul>
    </EmptyState>
  );
}

function ChoosePane({ count }: { count: number }) {
  const add = useAddKubeconfig();
  return (
    <EmptyState icon={Network} title="Choose a cluster" primary={{ label: "Add kubeconfig…", onClick: () => void add() }}>
      {`Pick one of your ${count} kubeconfig ${count === 1 ? "context" : "contexts"} in the navigator.`}
    </EmptyState>
  );
}

function FailurePane({ context, error }: { context: string; error: AppError }) {
  const { retryConnect, dismissConnectError } = useAppStore(useShallow((s) => ({ retryConnect: s.retryConnect, dismissConnectError: s.dismissConnectError })));
  const info = describeConnectError(error);
  return (
    <EmptyState icon={CAUSE_ICON[info.cause]} title={info.title}
      primary={{ label: "Retry", onClick: () => void retryConnect() }} secondary={{ label: "Choose another cluster", onClick: () => void dismissConnectError() }}>
      <p>Wiring couldn't connect to <span className="text-text-hi">{context}</span>.</p>
      <p className="selectable mt-2 break-words font-mono text-xs">{info.detail}</p>
      {info.hint && <p className="mt-2">{info.hint}</p>}
    </EmptyState>
  );
}
```

In `src/App.tsx`:

1. Add the imports:

```ts
import { useShallow } from "zustand/react/shallow";
import { ConnectionPane } from "./features/onboarding/ConnectionPane";
import { connectionPane } from "./features/onboarding/panes";
```

2. Add after `const maximized = useAppStore((s) => s.detailsMaximized);`:

```ts
  const pane = useAppStore(useShallow((s) => connectionPane(s.connection, s.contexts.length)));
```

3. Replace the `{!maximized && ( <> <ViewHeader /> <main …> … </main> </> )}` block with:

```tsx
        {!maximized && pane && (
          <main className="min-h-0 flex-1">
            <ErrorBoundary name="connection pane"><ConnectionPane pane={pane} /></ErrorBoundary>
          </main>
        )}
        {!maximized && !pane && (
          <>
            <ViewHeader />
            <main className="min-h-0 flex-1">
              <ErrorBoundary name="main view">{viewName === "graph" ? <Canvas /> : viewName === "custom" ? <CustomTableView key={customKey} /> : viewName === "helm" ? <HelmView /> : <TableView />}</ErrorBoundary>
            </main>
          </>
        )}
```

Keep the comment above the block.

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/features/onboarding src/app && pnpm typecheck`. Expected: PASS. That includes `src/app/smoke.test.tsx`, whose `/connect to a cluster/i` now matches the welcome pane's title. Typecheck is clean, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/features/onboarding src/App.tsx
git commit -m "Show welcome, connecting and connection-failure panes" -m "<trailers>"
```

---

### Task 11: Remove the undismissable first-launch modal

**Files:**
- Delete: `src/features/cluster/ContextPicker.tsx`
- Modify: `src/App.tsx`, `src/app/store.ts`, `src/app/startup.ts`, `src/app/useGlobalKeys.ts`, `src/features/cluster/Header.tsx`, `src/app/startup.test.ts`, `src/app/store.test.ts`, `src/app/wireEvents.test.ts`, `src/app/useGlobalKeys.test.tsx`, `src/features/cluster/cluster.test.tsx`

- [ ] **Step 1: Update the tests first.**

In `src/app/startup.test.ts`:

1. Replace the first test with:

```ts
  it("connects nothing when there is no remembered context", async () => {
    await startup();
    expect(useAppStore.getState().contexts).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("connect", expect.anything());
  });
```

2. Replace `it("opens the picker when there are no contexts at all", …)` with:

```ts
  it("leaves an app without contexts to the welcome pane", async () => {
    vi.mocked(invoke).mockImplementationOnce(async (cmd: string) => (cmd === "list_contexts" ? [] : null));
    await startup();
    expect(useAppStore.getState().contexts).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith("connect", expect.anything());
  });
```

3. In `auto-connects the remembered context and namespace`, delete the line `expect(s.pickerOpen).toBe(false);`.
4. Rename `does not connect, nor open the picker, when the remembered context no longer exists` to `does not connect when the remembered context no longer exists`, and delete its line `expect(useAppStore.getState().pickerOpen).toBe(false);`.
5. Rename `stays on the Navigator when connecting the remembered context fails` to `shows the failure when connecting the remembered context fails`, and replace its line `expect(useAppStore.getState().pickerOpen).toBe(false);` with:

```ts
    expect(useAppStore.getState().connection.lastError).toEqual({ context: "prod", error: { kind: "internal", message: "connect failed" } });
```

In `src/app/store.test.ts`:

1. Rename `disconnectedState keeps contexts, hidden kinds and toasts; the picker opens only with nothing to pick from` to `disconnectedState keeps contexts, hidden kinds and toasts`. Delete its lines `expect(d.pickerOpen).toBe(false); // the Navigator lists the contexts; no modal needed` and `expect(disconnectedState({ ...s, contexts: [] as AppState["contexts"] } as AppState).pickerOpen).toBe(true);`.
2. In `disconnect failure is toasted and state is reset`, delete `expect(s.pickerOpen).toBe(true);`.

In `src/app/wireEvents.test.ts`, in `a disconnected state while a connect is in flight does not reset the store`, delete `expect(s.pickerOpen).toBe(false);`.

In `src/app/useGlobalKeys.test.tsx`:

1. Delete the whole test `Escape does not touch the selection while the context picker is open`.
2. Rename `Cmd/Ctrl+S is ignored under the picker or a dialog, and with Shift held` to `Cmd/Ctrl+S is ignored under a dialog, and with Shift held`. In it, delete the `{ pickerOpen: true },` entry of `layers`, and in both `useAppStore.setState({ pickerOpen: false, discardDialog, deleteDialog, createDialog, … })` calls delete `pickerOpen: false, `.

In `src/features/cluster/cluster.test.tsx`:

1. Change the first import to `import { fireEvent, render, screen } from "@testing-library/react";` (`waitFor` was only used by the picker tests).
2. Delete `import { ContextPicker } from "./ContextPicker";` and the whole `describe("ContextPicker", …)` block.
3. Add inside `describe("connectContext", …)`, after its existing test, the case that the deleted picker test used to cover:

```tsx
  it("opens the context's default namespace when nothing is remembered", async () => {
    const { connectContext } = await import("./connectContext");
    const selectNamespace = vi.fn(async () => {});
    useAppStore.setState({
      contexts: [{ name: "prod", cluster: "c", user: "u", namespace: "shop", sourceFile: "/k" }],
      connect: vi.fn(async () => true), selectNamespace,
    });
    expect(await connectContext("prod")).toBe(true);
    expect(selectNamespace).toHaveBeenCalledWith("shop");
  });
```

4. Replace `it("the context button toggles the navigator when contexts exist, and opens the picker otherwise", …)` with:

```tsx
  it("the context button toggles the navigator, with or without contexts", () => {
    const toggleSidebar = vi.fn(async () => {});
    useAppStore.setState({ contexts: [], connection: { ...initialState().connection }, toggleSidebar });
    const { unmount } = render(<Header />);
    fireEvent.click(screen.getByRole("button", { name: /choose cluster/i }));
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    unmount();

    useAppStore.setState({
      contexts: [{ name: "prod", cluster: "c", user: "u", namespace: null, sourceFile: "/k" }],
      connection: { ...initialState().connection, context: "prod", state: "connected" }, toggleSidebar,
    });
    render(<Header />);
    fireEvent.click(screen.getByRole("button", { name: /prod/ }));
    expect(toggleSidebar).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/app src/features/cluster`. Expected: FAIL. The header test sees no `toggleSidebar` call for "choose cluster", because the button still opens the picker.

- [ ] **Step 3: Implement.**

Delete `src/features/cluster/ContextPicker.tsx` (`git rm src/features/cluster/ContextPicker.tsx`).

In `src/App.tsx`, delete `import { ContextPicker } from "./features/cluster/ContextPicker";` and the line `<ErrorBoundary name="cluster picker"><ContextPicker /></ErrorBoundary>`.

In `src/app/store.ts`:

1. Delete `  pickerOpen: boolean;` from `AppState`, `  setPickerOpen: (open: boolean) => void;` from its actions, `    pickerOpen: false,` from `initialState()`, `"setPickerOpen" | ` from the `Actions` type (the line becomes `| "dismissToast" | "showGraph" | "showTable" | "refreshTable" | "setIncludeHelmStorage"`), and the implementation line `  setPickerOpen: (pickerOpen) => set({ pickerOpen }),`.
2. Replace `disconnectedState` and its doc comment with:

```ts
/** The state after the session is gone: graph, selection and connection reset, the context list,
 *  the kubeconfig sources, kind filters, toasts and the sidebar collapse preference kept. The
 *  centre pane then shows the welcome, choose or failure pane (`connectionPane`). */
export function disconnectedState(s: AppState): Omit<AppState, keyof Actions> {
  const lost = lostEditsToast(s);
  return {
    ...initialState(), contexts: s.contexts, hiddenKinds: s.hiddenKinds, toasts: lost ? [...s.toasts, { id: ++toastSeq, ...lost }] : s.toasts,
    sidebarCollapsed: s.sidebarCollapsed, kubeconfigSources: s.kubeconfigSources,
  };
}
```

Replace `src/app/startup.ts` with:

```ts
import { restoredScope } from "../shared/scope";
import { settings } from "../shared/settings";
import { useAppStore } from "./store";

/** Boot: load contexts and reconnect the remembered context/scope. Without contexts the welcome
 *  pane takes over (it loads the kubeconfig sources itself); without a remembered context, or when
 *  it is gone, the navigator's cluster list is the way forward; a failed connect shows its pane. */
export async function startup(): Promise<void> {
  const s = useAppStore.getState;
  useAppStore.setState({ sidebarCollapsed: await settings.getSidebarCollapsed() });
  await s().loadContexts();
  if (s().contexts.length === 0) return;
  const last = await settings.get<string>("lastContext");
  const ctx = last ? s().contexts.find((c) => c.name === last) : undefined;
  if (!ctx) return;
  if (!(await s().connect(ctx.name))) return;
  const remembered = await settings.getLastScope(ctx.name);
  const { namespaces, canListNamespaces } = s().connection;
  // All namespaces needs the permission to list them (it may have been revoked since).
  const scope = restoredScope(remembered, namespaces, canListNamespaces, ctx.namespace);
  if (scope) await s().selectScope(scope);
}
```

In `src/app/useGlobalKeys.ts`, change `const modal = s.pickerOpen || s.discardDialog.open || …` to start with `const modal = s.discardDialog.open || …` (keep the rest of the expression). Delete the two lines:

```ts
      // An open context picker owns Escape (it closes itself when it can, marking the event handled).
      if (s.pickerOpen) return;
```

Replace `src/features/cluster/Header.tsx` with:

```tsx
import mark from "../../assets/mark.svg";
import { Plus, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { isMac } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";
import { Dot } from "../../shared/ui/Dot";
import { UpdatePill } from "../update/UpdatePill";
import { ForwardsIndicator } from "../forward/ForwardsIndicator";
import { NamespacePicker } from "./NamespacePicker";

export function Header() {
  const { connection, search, sidebarCollapsed, setSearch, reconnect, toggleSidebar, openCreate } = useAppStore(
    useShallow((s) => ({
      connection: s.connection, search: s.search, sidebarCollapsed: s.sidebarCollapsed,
      setSearch: s.setSearch, reconnect: s.reconnect, toggleSidebar: s.toggleSidebar, openCreate: s.openCreate,
    })),
  );
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The Navigator normally hosts the macOS traffic lights; its 48 px rail is too narrow for them.
  const inset = isMac && sidebarCollapsed ? "pl-12" : "";

  return (
    <header className={`drag-region flex h-16 shrink-0 items-center gap-3 border-b border-border bg-space/80 px-6 backdrop-blur-md ${inset}`}>
      <span className="mr-3 flex items-center gap-2 text-base font-semibold tracking-[-0.1px] text-text-hi">
        <img src={mark} alt="" width={22} height={22} className="select-none" draggable={false} />
        Wiring
      </span>
      {/* Cluster switching lives in the Navigator (its Clusters section, with Add kubeconfig…). */}
      <button type="button" className="no-drag rounded-xl border border-border-strong bg-surface px-4 py-1.5 text-sm font-medium text-text-hi hover:bg-muted"
        onClick={() => void toggleSidebar()} title="Toggle navigator">
        ⎈ <span>{connection.context ?? "choose cluster"}</span>{connection.serverVersion ? <span className="ml-2 text-xs font-normal text-text-muted">{connection.serverVersion}</span> : null}
      </button>
      {connection.context && <NamespacePicker />}
      {connection.context && (
        <Button className="flex items-center gap-1.5" disabled={connection.scope === null} onClick={() => openCreate()}
          title={connection.scope === null ? "Select a namespace first" : "Create an object in this namespace"}>
          <Plus className="size-4" /> Create
        </Button>
      )}
      <div className="no-drag relative ml-auto">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-text-muted" />
        <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search  ${isMac ? "⌘" : "Ctrl+"}K`}
          className="h-9 w-64 rounded-xl border border-border-strong bg-surface pl-9 pr-3 text-sm text-text-hi outline-none placeholder:text-text-muted focus:border-accent" />
      </div>
      <UpdatePill />
      <ForwardsIndicator />
      <Dot status={connection.state} className="mx-1 size-2.5" />
      {connection.context && (
        <Button disabled={connection.busy} onClick={() => void reconnect()}>Reconnect</Button>
      )}
    </header>
  );
}
```

- [ ] **Step 4: Check that nothing refers to the picker any more, and run the tests.** Run: `grep -rn "pickerOpen\|setPickerOpen\|ContextPicker" src`. Expected: no output. Run: `pnpm vitest run && pnpm typecheck`. Expected: PASS (the whole suite), typecheck clean, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add -A src
git commit -m "Replace the first-launch cluster modal with the welcome pane" -m "<trailers>"
```

---

### Task 12: Namespace picker opens on request

**Files:**
- Modify: `src/features/cluster/NamespacePicker.tsx`, `src/features/cluster/cluster.test.tsx`

- [ ] **Step 1: Write the failing tests.** In `src/features/cluster/cluster.test.tsx`, change the first import to `import { act, fireEvent, render, screen } from "@testing-library/react";`. Add at the end of the file:

```tsx
describe("NamespacePicker on request", () => {
  it("opens when an empty state asks for it", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: ["blog", "shop"], scope: null } });
    render(<NamespacePicker />);
    expect(screen.queryByRole("dialog", { name: "Namespaces" })).toBeNull();
    act(() => useAppStore.getState().openNamespacePicker());
    expect(screen.getByRole("dialog", { name: "Namespaces" })).toBeInTheDocument();
  });

  it("does not open for a request made before it mounted", () => {
    useAppStore.setState({ namespacePickerSeq: 3, connection: { ...initialState().connection, context: "prod", namespaces: ["shop"], scope: null } });
    render(<NamespacePicker />);
    expect(screen.queryByRole("dialog", { name: "Namespaces" })).toBeNull();
  });

  it("focuses the free-text field when there is no list to show", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: [], canListNamespaces: false, scope: null } });
    render(<NamespacePicker />);
    act(() => useAppStore.getState().openNamespacePicker());
    expect(screen.getByRole("textbox", { name: "Namespace" })).toHaveFocus();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/features/cluster/cluster.test.tsx`. Expected: FAIL. No dialog `Namespaces` is found after the request, and the field does not have focus.

- [ ] **Step 3: Implement.** In `src/features/cluster/NamespacePicker.tsx`, add after the existing `useEffect(() => { if (!open) return; … }, [open]);` block:

```ts
  // An empty state's "Choose a namespace" (`openNamespacePicker`): open the panel, or focus the
  // free-text field when there is no list. A request made before this mounted is not replayed.
  const pickerSeq = useAppStore((s) => s.namespacePickerSeq);
  const seenSeq = useRef(pickerSeq);
  const freeText = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pickerSeq === seenSeq.current) return;
    seenSeq.current = pickerSeq;
    if (namespaces.length === 0) {
      freeText.current?.focus();
      return;
    }
    setTicked(new Set(scope === null || scope === "all" ? [] : scope));
    setFilter("");
    setOpen(true);
  }, [pickerSeq, namespaces.length, scope]);
```

In the `if (namespaces.length === 0) { return ( <input aria-label="Namespace" … /> ); }` branch, add `ref={freeText}` to that `<input>`.

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/features/cluster src/features/graph`. Expected: PASS, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/features/cluster
git commit -m "Open the namespace picker from empty states" -m "<trailers>"
```

---

### Task 13: Table empty states and the partial-access note

**Files:**
- Create: `src/features/table/tableEmptyState.ts`, `src/features/table/tableEmptyState.test.ts`, `src/features/table/TableEmpty.tsx`
- Modify: `src/features/table/TableView.tsx`, `src/features/table/TableView.test.tsx`

- [ ] **Step 1: Write the failing tests.** Create `src/features/table/tableEmptyState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tableEmptyState, type TableEmptyInput } from "./tableEmptyState";

const input = (over: Partial<TableEmptyInput> = {}): TableEmptyInput => ({ scope: "shop", denied: false, loaded: true, total: 3, shown: 3, search: "", ...over });

describe("tableEmptyState", () => {
  it("resolves the situations in priority order", () => {
    expect(tableEmptyState(input({ scope: null, denied: true, loaded: false }))).toEqual({ type: "noNamespace" });
    expect(tableEmptyState(input({ denied: true, loaded: false }))).toEqual({ type: "noAccess", scope: "shop" });
    expect(tableEmptyState(input({ loaded: false, total: 0 }))).toEqual({ type: "loading" });
    expect(tableEmptyState(input({ total: 0, shown: 0 }))).toEqual({ type: "empty", scope: "shop" });
    expect(tableEmptyState(input({ shown: 0, search: " web " }))).toEqual({ type: "noMatch", query: "web" });
    expect(tableEmptyState(input())).toBeNull();
  });
});
```

In `src/features/table/TableView.test.tsx`:

1. Replace `expect(screen.getByText("No Pods in payments")).toBeInTheDocument();` with:

```tsx
    expect(screen.getByRole("region", { name: "Nothing here yet" })).toHaveTextContent("payments has no Pods.");
    fireEvent.click(screen.getByRole("button", { name: "+ Create" }));
    expect(useAppStore.getState().createDialog).toMatchObject({ open: true, kind: "Pod" });
```

2. Replace `expect(screen.getByText("No access to Secrets (RBAC)")).toBeInTheDocument();` with:

```tsx
    expect(screen.getByRole("region", { name: "No access" })).toHaveTextContent("You can't list Secrets in payments (RBAC). Ask your cluster admin, or pick another namespace.");
```

3. Add inside the `describe` block:

```tsx
  it("notes missing namespaces above the rows of a partial kind", () => {
    useAppStore.setState({ partialKinds: new Set(["Pod"]) });
    render(<TableView />);
    expect(screen.getByText("Some namespaces are missing: no access (RBAC).")).toBeInTheDocument();
    expect(names()).toEqual(["web-1", "api", "db"]);
  });

  it("asks for a namespace before one is chosen", () => {
    useAppStore.setState({ connection: { ...connected(), scope: null } });
    render(<TableView />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a namespace" }));
    expect(useAppStore.getState().namespacePickerSeq).toBe(1);
  });

  it("clears a search that matches nothing", () => {
    useAppStore.setState({ search: "nothing-here" });
    render(<TableView />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(useAppStore.getState().search).toBe("");
  });
```

The existing `filters rows by the header search` (`/no pods match/i`) and the two loading tests (`/loading pods/i`) keep passing unchanged.

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/features/table`. Expected: FAIL with `Failed to resolve import "./tableEmptyState"`. Once that file exists, the `TableView` tests still fail because no `region` is rendered.

- [ ] **Step 3: Implement.** Create `src/features/table/tableEmptyState.ts`:

```ts
export type TableSituation =
  | { type: "noNamespace" }
  | { type: "noAccess"; scope: string }
  | { type: "loading" }
  | { type: "empty"; scope: string }
  | { type: "noMatch"; query: string };

export interface TableEmptyInput {
  /** The scope's label (`scopeLabel`, or "The cluster"), `null` before a namespace is chosen. */
  scope: string | null;
  denied: boolean;
  /** The rows on hand are this scope's. */
  loaded: boolean;
  /** Rows in the scope, before the search filter. */
  total: number;
  /** Rows left after the search filter. */
  shown: number;
  search: string;
}

/** Why a table has no rows to show, in priority order, or `null` when it has some (pure; shared by
 *  the built-in, custom and Helm tables). */
export function tableEmptyState(i: TableEmptyInput): TableSituation | null {
  if (i.scope === null) return { type: "noNamespace" };
  if (i.denied) return { type: "noAccess", scope: i.scope };
  if (!i.loaded) return { type: "loading" };
  if (i.total === 0) return { type: "empty", scope: i.scope };
  if (i.shown === 0) return { type: "noMatch", query: i.search.trim() };
  return null;
}
```

Create `src/features/table/TableEmpty.tsx`:

```tsx
import { Inbox, Layers, LoaderCircle, SearchX, ShieldOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { EmptyState } from "../../shared/EmptyState";
import { noNamespaceBody } from "../graph/graphEmptyState";
import type { TableSituation } from "./tableEmptyState";

/** A table view's empty state. `noun` is what the table lists ("Pods", "certificates");
 *  `onCreate` adds **+ Create** to the empty state; `noAccessBody` replaces the RBAC sentence. */
export function TableEmpty({ state, noun, onCreate, noAccessBody }: { state: TableSituation; noun: string; onCreate?: () => void; noAccessBody?: string }) {
  const { canList, openNamespacePicker, setSearch } = useAppStore(useShallow((s) => ({
    canList: s.connection.canListNamespaces, openNamespacePicker: s.openNamespacePicker, setSearch: s.setSearch,
  })));
  const pickAnother = { label: "Pick another namespace", onClick: openNamespacePicker };
  switch (state.type) {
    case "noNamespace":
      return <EmptyState icon={Layers} title="Choose a namespace" primary={{ label: "Choose a namespace", onClick: openNamespacePicker }}>{noNamespaceBody(canList)}</EmptyState>;
    case "noAccess":
      return (
        <EmptyState icon={ShieldOff} title="No access" primary={pickAnother}>
          {noAccessBody ?? `You can't list ${noun} in ${state.scope} (RBAC). Ask your cluster admin, or pick another namespace.`}
        </EmptyState>
      );
    case "loading":
      return <EmptyState icon={LoaderCircle} spinning title={`Loading ${noun}…`} />;
    case "empty":
      return (
        <EmptyState icon={Inbox} title="Nothing here yet" primary={onCreate ? { label: "+ Create", onClick: onCreate } : pickAnother} secondary={onCreate ? pickAnother : undefined}>
          {`${state.scope} has no ${noun}.`}
        </EmptyState>
      );
    case "noMatch":
      return (
        <EmptyState icon={SearchX} title="No matches" primary={{ label: "Clear search", onClick: () => setSearch("") }}>
          {`No ${noun} match “${state.query}”.`}
        </EmptyState>
      );
  }
}
```

In `src/features/table/TableView.tsx`:

1. Add the imports:

```ts
import { isCreatable } from "../editor/templates";
import { TableEmpty } from "./TableEmpty";
import { tableEmptyState } from "./tableEmptyState";
```

2. Replace the destructuring line `const { kind, table, search, selectedId, denied, scope, namespaces, graphReady, includeHelmStorage, setIncludeHelmStorage, select, focusInGraph, openActionsMenu } = useAppStore(` with:

```ts
  const { kind, table, search, selectedId, denied, partial, scope, namespaces, graphReady, includeHelmStorage, setIncludeHelmStorage, select, focusInGraph, openActionsMenu, openCreate } = useAppStore(
```

and in the selector, replace `denied: kind ? s.deniedKinds.has(kind) : false, scope: s.connection.scope, namespaces: s.connection.namespaces, graphReady: s.graphReady,` with:

```ts
        denied: kind ? s.deniedKinds.has(kind) : false, partial: kind ? s.partialKinds.has(kind) : false,
        scope: s.connection.scope, namespaces: s.connection.namespaces, graphReady: s.graphReady, openCreate: s.openCreate,
```

3. Replace the `let message: string | null = null;` line and the five `if`/`else if` lines after it with:

```ts
  // Rows are refetched once the scope's snapshot lands; until then a leftover table is not this scope's.
  const empty = tableEmptyState({
    scope: scopeLabel(scope, namespaces), denied, loaded: !!table && graphReady, total: table?.rows.length ?? 0, shown: rows.length, search,
  });
```

4. Add after the closing `)}` of the `{kind === "Secret" && !denied && ( <label …>Show Helm storage</label> )}` block:

```tsx
      {partial && !denied && scope && (
        <p className="mb-3 text-xs text-text-muted">Some namespaces are missing: no access (RBAC).</p>
      )}
```

5. Replace `{message && <div className="grid h-full place-items-center text-text-muted">{message}</div>}` with:

```tsx
      {empty && <TableEmpty state={empty} noun={plural} onCreate={isCreatable(kind) ? () => openCreate() : undefined} />}
```

`openCreate()` with no argument already picks the open table's kind.

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/features/table && pnpm typecheck`. Expected: PASS, typecheck clean, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/features/table
git commit -m "Explain empty tables and note partially readable kinds" -m "<trailers>"
```

---

### Task 14: Custom and Helm views use the shared empty states

**Files:**
- Modify: `src/features/table/CustomTableView.tsx`, `src/features/table/CustomTableView.test.tsx`, `src/features/helm/HelmView.tsx`, `src/features/helm/HelmView.test.tsx`

- [ ] **Step 1: Update the tests.** In `src/features/table/CustomTableView.test.tsx`:

1. In `says when the kind has no objects in the scope`, replace `expect(screen.getByText(/No Certificate in/)).toBeInTheDocument();` with:

```tsx
    expect(screen.getByRole("region", { name: "Nothing here yet" })).toHaveTextContent("shop has no certificates.");
    fireEvent.click(screen.getByRole("button", { name: "+ Create" }));
    expect(useAppStore.getState().createDialog).toMatchObject({ open: true, custom: cert });
```

2. In `shows the watch's terminal error instead of the rows, with a Retry that lists again`, replace `expect(screen.queryByText(/No Certificate in/)).toBeNull();` with:

```tsx
    expect(screen.getByRole("region", { name: "Can't list Certificate" })).toBeInTheDocument();
    expect(screen.queryByText(/has no certificates/)).toBeNull();
```

In `src/features/helm/HelmView.test.tsx`, in `says releases are unreadable when Secrets are denied, not that there are none`, replace the two `expect` lines with:

```tsx
    expect(screen.getByRole("region", { name: "No access" })).toHaveTextContent(
      "You can't list Secrets in shop, and Helm keeps its releases there (RBAC). Ask your cluster admin, or pick another namespace.",
    );
    expect(screen.queryByText(/has no Helm releases/)).toBeNull();
```

and add inside its `describe` block:

```tsx
  it("says when the scope has no releases", () => {
    useAppStore.setState({ helmReleases: [] });
    render(<HelmView />);
    expect(screen.getByRole("region", { name: "Nothing here yet" })).toHaveTextContent("shop has no Helm releases.");
  });
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/features/table/CustomTableView.test.tsx src/features/helm/HelmView.test.tsx`. Expected: FAIL. No `region` named `Nothing here yet`, `Can't list Certificate` or `No access` is found.

- [ ] **Step 3: Implement.** In `src/features/table/CustomTableView.tsx`:

1. Replace `import { Button } from "../../shared/ui/Button";` with:

```ts
import { CircleAlert } from "lucide-react";
import { EmptyState } from "../../shared/EmptyState";
import { TableEmpty } from "./TableEmpty";
import { tableEmptyState } from "./tableEmptyState";
```

2. In the destructuring, add `openCreate` after `refreshCustom`. In the selector's returned object, add `openCreate: s.openCreate,` after `refreshCustom: s.refreshCustom,`.

3. Replace the `if (error) { return ( <div …> … </div> ); }` block with:

```tsx
  if (error) {
    return (
      <EmptyState icon={CircleAlert} title={`Can't list ${resource.kind}`} primary={{ label: "Retry", onClick: () => void refreshCustom(resource) }}>
        <span role="alert">{error}</span>
      </EmptyState>
    );
  }
```

4. Replace the `let message: string | null = null;` line and the four `if`/`else if` lines after it with:

```ts
  const label = scopeLabel(scope, namespaces);
  const empty = tableEmptyState({
    scope: label === null ? null : resource.namespaced ? label : "The cluster",
    denied: false, loaded: !!table, total: table?.rows.length ?? 0, shown: rows.length, search,
  });
```

5. Replace `{message && <div className="grid h-full place-items-center text-text-muted">{message}</div>}` with:

```tsx
      {empty && <TableEmpty state={empty} noun={resource.plural} onCreate={() => openCreate()} />}
```

`openCreate()` on a custom view already starts from that kind's template.

In `src/features/helm/HelmView.tsx`:

1. Add the imports:

```ts
import { TableEmpty } from "../table/TableEmpty";
import { tableEmptyState } from "../table/tableEmptyState";
```

2. Replace the `let message: string | null = null;` line and the five `if`/`else if` lines after it with:

```ts
  const label = scopeLabel(scope, namespaces);
  const empty = tableEmptyState({ scope: label, denied, loaded: releases !== null, total: releases?.length ?? 0, shown: rows.length, search });
```

3. Replace `{message && <div className="grid flex-1 place-items-center text-text-muted">{message}</div>}` with:

```tsx
      {empty && (
        <div className="min-h-0 flex-1">
          <TableEmpty state={empty} noun="Helm releases"
            noAccessBody={`You can't list Secrets in ${label}, and Helm keeps its releases there (RBAC). Ask your cluster admin, or pick another namespace.`} />
        </div>
      )}
```

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/features/table src/features/helm && pnpm typecheck`. Expected: PASS, typecheck clean, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/features/table src/features/helm
git commit -m "Use the shared empty states in the custom and Helm views" -m "<trailers>"
```

---

### Task 15: Too-large switch notice, once per scope

**Files:**
- Modify: `src/app/store.ts`, `src/app/store.onboarding.test.ts`

- [ ] **Step 1: Write the failing test.** Add at the end of `src/app/store.onboarding.test.ts`:

```ts
describe("too-large switch notice", () => {
  const big = { nodes: [], edges: [], tooLarge: { nodes: 1873, kinds: [] } };
  const notices = () => useAppStore.getState().toasts.filter((t) => t.message.includes("too many to draw"));

  it("says so once per scope when the graph switches to a table", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop"] } });
    useAppStore.getState().applySnapshot(big);
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Deployment" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ kind: "info", message: expect.stringContaining("1,873 objects") });

    // Back to the graph, another rebuild of the same scope: switched again, not said again.
    useAppStore.getState().showGraph();
    useAppStore.getState().applySnapshot(big);
    expect(useAppStore.getState().view.name).toBe("table");
    expect(notices()).toHaveLength(1);

    useAppStore.setState((s) => ({ connection: { ...s.connection, scope: "all" } }));
    useAppStore.getState().showGraph();
    useAppStore.getState().applySnapshot(big);
    expect(notices()).toHaveLength(2);
  });

  it("says nothing when a table was already on screen", () => {
    useAppStore.setState({ view: { name: "table", kind: "Pod" }, connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop"] } });
    useAppStore.getState().applySnapshot(big);
    expect(notices()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to see it fail.** Run: `pnpm vitest run src/app/store.onboarding.test.ts`. Expected: FAIL. `notices()` has length 0 after the first switch.

- [ ] **Step 3: Implement.** In `src/app/store.ts`:

1. In `interface AppState`, add after `tooLarge: TooLarge | null;`:

```ts
  /** `context|scope` of the last too-large switch notice, so it is said once per scope. */
  tooLargeNotified: string | null;
```

2. In `initialState()`, add after `tooLarge: null,`:

```ts
    tooLargeNotified: null,
```

3. In the `applySnapshot` action, replace the line `if (s.tooLarge && s.view.name === "graph") set({ view: { name: "table", kind: s.lastTableKind ?? "Deployment" } });` with:

```ts
    if (s.tooLarge && s.view.name === "graph") {
      set({ view: { name: "table", kind: s.lastTableKind ?? "Deployment" } });
      // Said once per scope: the backend sends a too-large snapshot on every rebuild.
      const key = `${s.connection.context}|${JSON.stringify(s.connection.scope)}`;
      if (s.tooLargeNotified !== key) {
        set({ tooLargeNotified: key });
        get().toast({
          kind: "info",
          message: `${s.tooLarge.nodes.toLocaleString("en-US")} objects are too many to draw, so Wiring shows tables. Pick fewer namespaces to see the graph.`,
        });
      }
    }
```

`connect` resets the field through `initialState()`, so a new connection starts afresh.

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/app && pnpm typecheck`. Expected: PASS, typecheck clean, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/app/store.ts src/app/store.onboarding.test.ts
git commit -m "Say once per scope why the graph switched to tables" -m "<trailers>"
```

---

### Task 16: Header wording and toast titles

**Files:**
- Modify: `src/features/cluster/Header.tsx`, `src/features/cluster/cluster.test.tsx`, `src/shared/ui/Toasts.tsx`
- Create: `src/shared/ui/Toasts.test.tsx`

- [ ] **Step 1: Write the failing tests.** Add at the end of `src/features/cluster/cluster.test.tsx`:

```tsx
describe("Header status", () => {
  it("shows the context being dialled with a spinner", () => {
    useAppStore.setState({ connection: { ...initialState().connection, connecting: "staging", busy: true } });
    render(<Header />);
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByLabelText("Connecting")).toBeInTheDocument();
  });

  it("says Reconnecting… while the connection is degraded", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "degraded" } });
    render(<Header />);
    expect(screen.getByText("Reconnecting…")).toHaveAttribute("title", "Some resources can't be watched right now; Wiring keeps retrying.");
  });

  it("says nothing extra while connected", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" } });
    render(<Header />);
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(screen.queryByLabelText("Connecting")).toBeNull();
  });
});
```

Create `src/shared/ui/Toasts.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { Toasts } from "./Toasts";

vi.mock("../ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

beforeEach(() => useAppStore.setState(initialState()));

describe("Toasts", () => {
  it("titles error toasts in words, and info toasts not at all", () => {
    useAppStore.setState({
      toasts: [
        { id: 1, kind: "network", message: "connection refused" },
        { id: 2, kind: "forbidden", message: "pods is forbidden" },
        { id: 3, kind: "internal", message: "boom" },
        { id: 4, kind: "info", message: "Added team.yaml: 2 contexts" },
      ],
    });
    render(<Toasts />);
    expect(screen.getByText("Network error")).toBeInTheDocument();
    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Added team.yaml: 2 contexts")).toBeInTheDocument();
    expect(screen.queryByText("network")).toBeNull();
    expect(screen.queryByText("info")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/features/cluster/cluster.test.tsx src/shared/ui/Toasts.test.tsx`. Expected: FAIL. The header shows `choose cluster` instead of `staging`, no "Reconnecting…" text is found, and the toasts show the raw kind `network`.

- [ ] **Step 3: Implement.** In `src/features/cluster/Header.tsx`:

1. Change `import { Plus, Search } from "lucide-react";` to `import { LoaderCircle, Plus, Search } from "lucide-react";`.
2. Replace the context button's inner line (`⎈ <span>{connection.context ?? "choose cluster"}</span>{connection.serverVersion ? … : null}`) with:

```tsx
        ⎈ <span>{connection.connecting ?? connection.context ?? "choose cluster"}</span>
        {connection.connecting !== null
          ? <LoaderCircle aria-label="Connecting" className="ml-2 inline size-3.5 animate-spin text-text-muted" />
          : connection.serverVersion ? <span className="ml-2 text-xs font-normal text-text-muted">{connection.serverVersion}</span> : null}
```

3. Add after `<Dot status={connection.state} className="mx-1 size-2.5" />`:

```tsx
      {connection.context && connection.state === "degraded" && (
        <span className="text-xs text-status-warn" title="Some resources can't be watched right now; Wiring keeps retrying.">Reconnecting…</span>
      )}
```

Replace `src/shared/ui/Toasts.tsx` with:

```tsx
import { Check, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { useAppStore, type Toast } from "../../app/store";
import type { ErrorKind } from "../ipc/types";

/** An error toast's title, by kind. */
export const ERROR_TITLES: Record<ErrorKind, string> = {
  network: "Network error",
  auth: "Authentication failed",
  forbidden: "Access denied",
  notFound: "Not found",
  conflict: "Conflict",
  invalid: "Invalid",
  internal: "Something went wrong",
};

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), 8000);
    return () => clearTimeout(t);
  }, [toast.id, dismiss]);
  const info = toast.kind === "info";
  // Both kinds are elevated cards; only the mark says which one it is.
  const look = "border-border bg-elevated text-text-hi";
  const Icon = info ? Check : TriangleAlert;
  return (
    <div role="alert" className={`pointer-events-auto flex items-start gap-2.5 rounded-toast border px-3.5 py-2.5 text-sm font-medium ${look}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${info ? "text-status-ok" : "text-status-err"}`} />
      <div className="min-w-0 flex-1 break-words">
        {toast.kind !== "info" && <div className="text-xs font-normal text-text-muted">{ERROR_TITLES[toast.kind]}</div>}
        {toast.message}
      </div>
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)} className="opacity-70 hover:opacity-100"><X className="size-4" /></button>
    </div>
  );
}

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-30 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/features/cluster src/shared && pnpm typecheck`. Expected: PASS, typecheck clean, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/features/cluster src/shared/ui
git commit -m "Say connecting and reconnecting in the header, and title toasts in words" -m "<trailers>"
```

---

### Task 17: Add-kubeconfig toasts

**Files:**
- Modify: `src/app/store.ts`, `src/app/store.onboarding.test.ts`

- [ ] **Step 1: Write the failing tests.** Add at the end of `src/app/store.onboarding.test.ts`:

```ts
describe("adding a kubeconfig", () => {
  it("says how many contexts the file brought, from its source report", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "add_kubeconfig") return [PROD];
      if (cmd === "kubeconfig_sources") return [...SOURCES, { path: "/Users/me/team.yaml", origin: "added", state: "ok", contexts: 2, error: null }];
      return null;
    });
    await useAppStore.getState().addKubeconfig("/Users/me/team.yaml");
    expect(useAppStore.getState().contexts).toEqual([PROD]);
    expect(useAppStore.getState().kubeconfigSources).toHaveLength(2);
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Added team.yaml: 2 contexts" });
  });

  it("says one context in the singular", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "add_kubeconfig") return [PROD];
      if (cmd === "kubeconfig_sources") return [{ path: "C:\\Users\\me\\one.yaml", origin: "added", state: "ok", contexts: 1, error: null }];
      return null;
    });
    await useAppStore.getState().addKubeconfig("C:\\Users\\me\\one.yaml");
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ message: "Added one.yaml: 1 context" });
  });

  it("toasts a refused file and saves nothing", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "invalid", message: "empty.yaml has no contexts" });
    await useAppStore.getState().addKubeconfig("/tmp/empty.yaml");
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "invalid", message: "empty.yaml has no contexts" });
    expect(called()).not.toContain("kubeconfig_sources");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail.** Run: `pnpm vitest run src/app/store.onboarding.test.ts`. Expected: FAIL. No info toast is found, and `kubeconfigSources` is still `null` after the add.

- [ ] **Step 3: Implement.** In `src/app/store.ts`, add above `export const useAppStore`:

```ts
/** `team.yaml` from `/Users/me/team.yaml` (or a Windows path). */
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
```

Replace the `addKubeconfig` action with:

```ts
  addKubeconfig: async (path) => {
    try {
      set({ contexts: await commands.addKubeconfig(path) });
    } catch (e) {
      // Missing, unparseable or without contexts: the backend refused it and saved nothing.
      get().toast(toAppError(e));
      return;
    }
    await get().loadKubeconfigSources();
    // The file's own count: the merged context list is first-file-wins and would undercount.
    const n = get().kubeconfigSources?.find((s) => s.path === path)?.contexts ?? 0;
    get().toast({ kind: "info", message: `Added ${fileName(path)}: ${n} ${n === 1 ? "context" : "contexts"}` });
  },
```

- [ ] **Step 4: Run the tests to see them pass.** Run: `pnpm vitest run src/app src/features/navigator src/features/onboarding && pnpm typecheck`. Expected: PASS (the Navigator's "adds a kubeconfig through the file dialog" still passes, because it mocks `addKubeconfig`), typecheck clean, and `echo $?` prints `0`.

- [ ] **Step 5: Commit.**

```bash
git add src/app/store.ts src/app/store.onboarding.test.ts
git commit -m "Say what adding a kubeconfig brought" -m "<trailers>"
```

---

### Task 18: README and full checks

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README.** Replace the paragraph that starts `Wiring reads your kubeconfig from` (under **Install**) with:

```markdown
Wiring reads your kubeconfig from `~/.kube/config`, or from `KUBECONFIG` when it is set. You can also add a kubeconfig file from inside the app with **Add kubeconfig…**. A file without contexts is refused. If Wiring finds no contexts at all, it opens on a welcome screen. That screen lists each file it looked at and what it found there (not found, unreadable, no contexts), with **Add kubeconfig…** and **Rescan**.

**Login helpers.** Clusters that sign in through a helper program, such as `gke-gcloud-auth-plugin`, `aws` or `kubelogin`, need it installed. On macOS and Linux, Wiring uses your login shell's `PATH`, so it finds a helper installed with Homebrew or a cloud SDK even when you start Wiring from the Dock or a launcher. Restart Wiring after installing one.
```

Add this paragraph to **Features**, right after the **Navigator.** paragraph:

```markdown
**Empty and error states.** When Wiring has nothing to show, the centre pane says why and offers the next step:
- While connecting, the pane and the header show which cluster Wiring is dialling.
- A failed connection names the cause, with **Retry** and **Choose another cluster**. The cause is one of: the cluster can't be reached, its certificate isn't trusted, your credentials were rejected, a login helper isn't installed (with how to install it), or the connection timed out after 20 seconds.
- A namespace with no objects, a namespace you have no access to (RBAC), every kind hidden by the chips, and a search with no matches each get their own message and button.
- Tables of kinds you can read in only some namespaces say so above the rows.
- While some resources can't be watched, the header reads *Reconnecting…*.
```

In **Project layout**, replace `    cluster/             header, context and namespace pickers` with:

```text
    cluster/             header, namespace picker
    onboarding/          welcome, connecting and connection-failure panes
```

and replace `  shared/                IPC types and commands, UI primitives` with `  shared/                IPC types and commands, UI primitives, empty states`.

- [ ] **Step 2: Run the full frontend checks.** Run: `pnpm typecheck && pnpm vitest run; echo $?`. Expected: typecheck clean, every test file passes, and the last line is `0`.

- [ ] **Step 3: Run the full backend checks.** Run (in `src-tauri/`): `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. Expected: no formatting diff, no clippy warnings, and every test passes (`test result: ok` for the lib, `ipc_fixtures` and `updater_config`). The live `smoke` test is skipped without a cluster, as before. If `cargo fmt --check` reports a diff, run `cargo fmt` and include the result in this commit.

- [ ] **Step 4: Build.** Run: `pnpm build`. Expected: `tsc` passes and `vite build` writes `dist/` without errors.

- [ ] **Step 5: Commit.**

```bash
git add README.md src-tauri
git commit -m "Document the welcome pane, login helpers and empty states" -m "<trailers>"
```

---

## Self-review

- **Spec coverage.**
  - §3 shared `EmptyState` (icon, title, body, up to two actions): Task 6.
  - Situation 1, no contexts (welcome pane listing sources, **Add kubeconfig…**, **Rescan**): Tasks 1, 2, 5, 7 and 10.
  - Situation 2, connecting (pane and header spinner): Tasks 7, 10 and 16.
  - Situation 3, connection failed (cause titles, first line, hint, **Retry**, **Choose another cluster**): Tasks 7, 8 and 10.
  - Situation 4, no namespace (both bodies; opens or focuses the picker): Tasks 9, 12 and 13.
  - Situations 5–8 (empty, no access, all kinds hidden, no matches): Task 9 for the graph, Tasks 13–14 for the tables.
  - Situation 9, too many objects (**Pick fewer namespaces** · **Open tables**): Task 9.
  - Too-large switch notice once per scope: Task 15.
  - Degraded "Reconnecting…" with tooltip: Task 16.
  - Partial note in built-in tables: Task 13.
  - Human toast titles: Task 16.
  - Add-kubeconfig success and no-contexts toasts: Tasks 2 and 17.
  - First-launch modal removed, Clusters section keeps its Add button: Task 11.
  - §4.1 `kubeconfig_sources`, `scan`, `list_contexts` reusing it, `add_kubeconfig` rejection: Tasks 1, 2 and 5.
  - §4.2 20 s connect timeout with `Network` "timed out after 20 s waiting for <server>": Task 3.
  - §4.3 login-shell `PATH`, 3 s timeout, fallback directories, pure `merge_path`, shell seam (`run_with_timeout` and `login_shell_path`), Windows unchanged: Task 4.
  - §4.4 causes and hints: Task 8.
  - §5 store state and actions: Tasks 7, 15 and 17. `openNamespacePicker`: Tasks 7 and 12. One pure situation function per view (`graphEmptyState`, `tableEmptyState`, `connectionPane`): Tasks 9, 10 and 13.
  - §6 Rust tests: Tasks 1–4. Vitest: every bullet in Tasks 7–17. No new smoke test, as the spec says.
- **Placeholder scan.** No "TBD", "add error handling" or "similar to Task N". Every code step has complete code. Edits to existing files name the exact lines they replace. The only deletions without replacement code are the named test assertions and the picker test block in Task 11, which have nothing to replace them.
- **Type consistency.**
  - `KubeconfigSource { path, origin, state, contexts, error }` is the same in Rust (camelCase via serde, `usize` → number), the fixture, `types.ts` and the contract doc. The `SourceOrigin`/`SourceState` strings are the same in every one of them.
  - `Connection.connecting` / `Connection.lastError: { context, error } | null` are used the same way in the store, `connectionPane`, `Header` and the tests.
  - The situation types `GraphSituation`, `TableSituation` and `Pane` are produced by their pure functions and consumed only by `GraphEmpty`, `TableEmpty` and `ConnectionPane`.
  - `noNamespaceBody` is defined once (graphEmptyState.ts) and shared.
  - `ConnectCause` keys `CAUSE_ICON`.
  - Commands and their names: `kubeconfig_sources` is in `register`, `commands.ts` and the contract doc.
- **Ordering.** Backend (Tasks 1–4) → contract (5) → `EmptyState` (6) → store (7) → `describeConnectError` (8) → graph (9) → panes (10–11) → namespace picker (12) → tables (13–14) → too-large toast (15) → wording and toasts (16–17) → README and checks (18). Each task leaves the suite green: tests touched by a behaviour change are updated in the same task.
