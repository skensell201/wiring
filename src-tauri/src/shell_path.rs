//! Give the app the login shell's `PATH` (macOS, Linux).
//!
//! An app started from the Dock or a desktop launcher inherits a minimal `PATH`, so kubeconfig
//! exec plugins installed with Homebrew or a cloud SDK (`gke-gcloud-auth-plugin`, `aws`,
//! `kubelogin`) are not found. At startup, before any kubeconfig is read, the app asks the
//! user's login shell for its `PATH` and merges it into its own.

use std::collections::HashSet;
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long the login shell gets to print its `PATH`.
pub const SHELL_TIMEOUT: Duration = Duration::from_secs(3);

const START: &str = "__WIRING_PATH_START__";
const END: &str = "__WIRING_PATH_END__";

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
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
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

/// The text between the last start marker and the end marker after it; `None` when either marker
/// is missing or the value is blank. rc files may print banners or prompts around it.
fn extract_marked(out: &str) -> Option<String> {
    let after = &out[out.rfind(START)? + START.len()..];
    let value = after[..after.find(END)?].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Arguments that make `shell` print its `PATH` between the markers; fish's `$PATH` is a list.
fn shell_args(shell: &Path) -> Vec<String> {
    let path = if shell.file_name().is_some_and(|n| n == "fish") {
        "(string join : $PATH)"
    } else {
        "\"$PATH\""
    };
    let script = format!("printf '{START}%s{END}' {path}");
    ["-i", "-l", "-c"]
        .into_iter()
        .map(String::from)
        .chain(std::iter::once(script))
        .collect()
}

/// The `PATH` an interactive login `shell` sets up, or `None` when it fails or takes too long.
pub fn login_shell_path(shell: &Path, timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(shell);
    cmd.args(shell_args(shell));
    extract_marked(&run_with_timeout(cmd, timeout)?)
}

/// A process started from a terminal already has that shell's `PATH`; only a Dock or launcher
/// start needs the (possibly slow) login shell.
fn should_query_shell(stdout_is_terminal: bool) -> bool {
    !stdout_is_terminal
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
/// shell is not asked or does not answer, the current one plus the common tool directories).
/// Call once at startup, before any other thread reads the environment.
pub fn apply_login_shell_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let from_shell = if should_query_shell(std::io::stdout().is_terminal()) {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default_shell().to_string());
        let found = login_shell_path(Path::new(&shell), SHELL_TIMEOUT);
        if found.is_none() {
            tracing::warn!(shell = %shell, "could not read the login shell's PATH; adding the common tool directories");
        }
        found
    } else {
        None
    };
    let merged = merge_path(&current, from_shell.as_deref(), &common_dirs());
    tracing::debug!(path = %merged, "PATH for kubeconfig exec plugins");
    std::env::set_var("PATH", merged);
}

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
        assert_eq!(
            run_with_timeout(Command::new("/nonexistent/wiring-shell"), Duration::from_secs(5)),
            None
        );
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

    #[test]
    fn extract_marked_skips_a_banner_before_and_noise_after() {
        let out = format!("welcome\n{START}/old{START}/a:/b{END}\nprompt$ ");
        assert_eq!(extract_marked(&out).as_deref(), Some("/a:/b"));
    }

    #[test]
    fn extract_marked_needs_both_markers_and_a_value() {
        assert_eq!(extract_marked("/usr/bin:/bin"), None);
        assert_eq!(extract_marked(&format!("{START}/usr/bin")), None);
        assert_eq!(extract_marked(&format!("{END}{START}")), None);
        assert_eq!(extract_marked(&format!("{START}{END}")), None);
        assert_eq!(extract_marked(&format!("{START}  {END}")), None);
    }

    #[test]
    fn shell_args_use_the_shells_own_syntax_for_path() {
        let posix = shell_args(Path::new("/bin/zsh"));
        assert_eq!(&posix[..3], ["-i", "-l", "-c"]);
        assert!(posix[3].contains("\"$PATH\""), "{}", posix[3]);
        let fish = shell_args(Path::new("/opt/homebrew/bin/fish"));
        assert_eq!(&fish[..3], ["-i", "-l", "-c"]);
        assert!(fish[3].contains("string join : $PATH"), "{}", fish[3]);
        assert!(fish[3].contains(START) && fish[3].contains(END));
    }

    #[test]
    fn the_shell_is_skipped_only_when_started_from_a_terminal() {
        assert!(should_query_shell(false));
        assert!(!should_query_shell(true));
    }
}
