//! Discover kubeconfig files and the contexts they define.

use std::path::{Path, PathBuf};

use kube::config::{Kubeconfig, KubeconfigError};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorKind};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub source_file: String,
}

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

/// A description of a kubeconfig read/parse failure built from the error's
/// kind and location only — never the parser's own text, which can echo
/// values (tokens, keys) from the file.
fn describe_read_error(e: &KubeconfigError) -> String {
    match e {
        KubeconfigError::ReadConfig(io, _) => io.kind().to_string(),
        KubeconfigError::Parse(parse) => match parse.location() {
            Some(at) => format!("not a valid kubeconfig (line {}, column {})", at.line(), at.column()),
            None => "not a valid kubeconfig".to_string(),
        },
        _ => "not a valid kubeconfig".to_string(),
    }
}

pub fn split_env_paths(value: &str) -> Vec<PathBuf> {
    std::env::split_paths(value).filter(|p| !p.as_os_str().is_empty()).collect()
}

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

/// One path, read.
enum Read {
    Missing,
    Invalid(String),
    Parsed(Box<Kubeconfig>),
}

fn read_one(path: &Path) -> Read {
    if !path.exists() {
        return Read::Missing;
    }
    match Kubeconfig::read_from(path) {
        Ok(cfg) => Read::Parsed(Box::new(cfg)),
        Err(e) => Read::Invalid(describe_read_error(&e)),
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
            Read::Parsed(cfg) => out.push((p.clone(), *cfg)),
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

/// All contexts across files, sorted by name. First file defining a name wins.
pub fn list_contexts(paths: &[PathBuf]) -> AppResult<Vec<ContextInfo>> {
    let mut seen = std::collections::HashSet::new();
    let mut contexts = vec![];
    for (path, cfg) in read_existing(paths) {
        for named in &cfg.contexts {
            if !seen.insert(named.name.clone()) {
                continue;
            }
            let ctx = named.context.clone().unwrap_or_default();
            contexts.push(ContextInfo {
                name: named.name.clone(),
                cluster: ctx.cluster,
                user: ctx.user.unwrap_or_default(),
                namespace: ctx.namespace,
                source_file: path.to_string_lossy().into_owned(),
            });
        }
    }
    contexts.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(contexts)
}

/// One merged Kubeconfig suitable for `kube::Config::from_custom_kubeconfig`.
pub fn load_merged(paths: &[PathBuf]) -> AppResult<Kubeconfig> {
    let mut merged = Kubeconfig::default();
    for (path, cfg) in read_existing(paths) {
        merged = merged.merge(cfg).map_err(|_| {
            AppError::new(
                ErrorKind::Internal,
                format!("could not merge {} with the other kubeconfig files", path.display()),
            )
        })?;
    }
    if merged.contexts.is_empty() {
        return Err(AppError::new(ErrorKind::NotFound, "no kubeconfig contexts found"));
    }
    Ok(merged)
}

pub fn path_strings(paths: &[PathBuf]) -> Vec<String> {
    paths.iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

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
            format!("{}: invalid kubeconfig ({})", path.display(), describe_read_error(&e)),
        )
    })?;
    // Deliberate: kubectl allows split kubeconfigs (clusters/users in one file), but a
    // file added here that brings no contexts adds nothing to pick, so it is refused.
    if cfg.contexts.is_empty() {
        return Err(AppError::new(ErrorKind::Invalid, format!("{} has no contexts", file_name(path))));
    }
    Ok(())
}

/// `team.yaml` from `/Users/me/team.yaml`, or the whole path when it has no file name.
fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// Refuses a path already among the loaded kubeconfig files (the `$KUBECONFIG` entries or
/// `~/.kube/config`, and the files added before): adding it again would change nothing.
/// Paths compare canonicalised where they exist, so another spelling of the same file matches.
pub fn ensure_not_loaded(path: &Path, loaded: &[PathBuf]) -> AppResult<()> {
    let key = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let wanted = key(path);
    if loaded.iter().any(|p| key(p) == wanted) {
        return Err(AppError::new(ErrorKind::Invalid, format!("{} is already loaded", file_name(path))));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn kubeconfig_file(dir: &std::path::Path, name: &str, contexts: &[(&str, &str, &str)]) -> PathBuf {
        let mut yaml = String::from("apiVersion: v1\nkind: Config\nclusters:\n  - name: c1\n    cluster: { server: https://127.0.0.1:6443 }\nusers:\n  - name: u1\n    user: { token: abc }\ncontexts:\n");
        for (ctx, cluster, user) in contexts {
            yaml.push_str(&format!(
                "  - name: {ctx}\n    context: {{ cluster: {cluster}, user: {user}, namespace: default }}\n"
            ));
        }
        yaml.push_str(&format!("current-context: {}\n", contexts[0].0));
        let path = dir.join(name);
        std::fs::File::create(&path).unwrap().write_all(yaml.as_bytes()).unwrap();
        path
    }

    #[test]
    fn lists_contexts_from_multiple_files_first_wins() {
        let dir = tempfile::tempdir().unwrap();
        let a = kubeconfig_file(dir.path(), "a", &[("prod", "c1", "u1"), ("shared", "c1", "u1")]);
        let b = kubeconfig_file(dir.path(), "b", &[("dev", "c1", "u1"), ("shared", "c1", "u1")]);
        let contexts = list_contexts(&[a.clone(), b.clone()]).unwrap();
        let names: Vec<&str> = contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["dev", "prod", "shared"]);
        let shared = contexts.iter().find(|c| c.name == "shared").unwrap();
        assert_eq!(shared.source_file, a.to_string_lossy());
        assert_eq!(shared.namespace.as_deref(), Some("default"));
        assert_eq!(shared.cluster, "c1");
    }

    #[test]
    fn missing_file_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let a = kubeconfig_file(dir.path(), "a", &[("prod", "c1", "u1")]);
        let contexts = list_contexts(&[dir.path().join("nope"), a]).unwrap();
        assert_eq!(contexts.len(), 1);
    }

    #[test]
    fn splits_kubeconfig_env_on_platform_separator() {
        let sep = if cfg!(windows) { ';' } else { ':' };
        let paths = split_env_paths(&format!("/a/one{sep}/b/two{sep}"));
        assert_eq!(paths, vec![PathBuf::from("/a/one"), PathBuf::from("/b/two")]);
    }

    #[test]
    fn merged_kubeconfig_can_select_a_context() {
        let dir = tempfile::tempdir().unwrap();
        let a = kubeconfig_file(dir.path(), "a", &[("prod", "c1", "u1")]);
        let merged = load_merged(&[a]).unwrap();
        assert!(merged.contexts.iter().any(|c| c.name == "prod"));
    }

    fn unparseable_file(dir: &std::path::Path) -> PathBuf {
        let path = dir.join("bad");
        std::fs::File::create(&path)
            .unwrap()
            .write_all(b"token: abc\nthis: [is: not: valid")
            .unwrap();
        path
    }

    #[test]
    fn unparseable_file_is_skipped_with_others_listed() {
        let dir = tempfile::tempdir().unwrap();
        let bad = unparseable_file(dir.path());
        let good = kubeconfig_file(dir.path(), "good", &[("prod", "c1", "u1")]);
        let contexts = list_contexts(&[bad, good]).unwrap();
        let names: Vec<&str> = contexts.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["prod"]);
    }

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
        assert_eq!(
            sources_from(Some(""), home),
            default,
            "an empty KUBECONFIG falls back to the default"
        );
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

    #[test]
    fn invalid_source_errors_never_echo_file_values() {
        let dir = tempfile::tempdir().unwrap();
        let mut sources = vec![];
        for (name, body) in [
            ("a", "apiVersion: v1\nkind: Config\ncontexts: SECRET-abc123\n"),
            ("b", "apiVersion: v1\nkind: Config\nusers: { token: SECRET-xyz }\n"),
            ("c", "apiVersion: v1\nkind: Config\nclusters: SECRET-q\n"),
            (
                "d",
                "apiVersion: v1\nkind: Config\ncontexts:\n  - name: SECRET-n\n    context: SECRET-ctx\n",
            ),
            (
                "e",
                "apiVersion: v1\nkind: Config\nusers:\n  - name: u\n    user: { token: [SECRET-t] }\n",
            ),
            (
                "g",
                "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: { server: x, insecure-skip-tls-verify: SECRET-b }\n",
            ),
            (
                "h",
                "apiVersion: v1\nkind: Config\nusers:\n  - name: u\n    user: { exec: { command: x, env: SECRET-e, apiVersion: y } }\n",
            ),
            ("i", "{\"apiVersion\": \"v1\", \"contexts\": \"SECRET-j\"}"),
            ("j", "apiVersion: v1\nkind: Config\nSECRET-k: 1\nSECRET-k: 2\n"),
            ("k", "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster: { server: x }\n    SECRET-dup: 1\n    name: SECRET-dup2\n    name: SECRET-dup3\n"),
            ("l", "apiVersion: v1\nkind: Config\nusers:\n  - name: u\n    user: { exec: { command: x, apiVersion: y, interactiveMode: SECRET-v } }\n"),
            ("m", "apiVersion: v1\nkind: Config\ncontexts: { SECRET-map: 1 }\n"),
            ("f", "apiVersion: SECRET-v\nkind: Config\ncurrent-context: [SECRET-c]\n"),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, body).unwrap();
            sources.push((path, SourceOrigin::Added));
        }
        for r in scan(&sources) {
            assert_eq!(r.state, SourceState::Invalid, "{r:?}");
            let err = r.error.unwrap();
            assert!(!err.contains("SECRET") && !err.contains('\n'), "{err}");
            assert!(err.starts_with("not a valid kubeconfig"), "{err}");
        }
        let located = scan(&sources[..1])[0].error.clone().unwrap();
        assert_eq!(located, "not a valid kubeconfig (line 3, column 11)");
        let v = validate_file(&dir.path().join("a")).unwrap_err();
        assert!(!v.message.contains("SECRET"), "{}", v.message);
    }

    #[test]
    fn a_directory_is_invalid_with_the_io_reason() {
        let dir = tempfile::tempdir().unwrap();
        let r = scan(&[(dir.path().to_path_buf(), SourceOrigin::Added)]);
        assert_eq!(r[0].state, SourceState::Invalid);
        let err = r[0].error.as_deref().unwrap();
        assert!(
            !err.is_empty() && !err.contains("not a valid kubeconfig") && !err.contains('\n'),
            "{err}"
        );
    }

    #[test]
    fn a_merge_failure_names_the_file_not_the_library_text() {
        let dir = tempfile::tempdir().unwrap();
        let a = kubeconfig_file(dir.path(), "a", &[("prod", "c1", "u1")]);
        let b = dir.path().join("b");
        std::fs::write(&b, "apiVersion: v1\nkind: Other\ncontexts: []\n").unwrap();
        let err = load_merged(&[a, b.clone()]).unwrap_err();
        assert_eq!(
            err.message,
            format!("could not merge {} with the other kubeconfig files", b.display())
        );
    }

    #[test]
    fn validate_file_rejects_a_file_without_contexts() {
        let dir = tempfile::tempdir().unwrap();
        let err = validate_file(&empty_file(dir.path())).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "empty has no contexts");
        let good = kubeconfig_file(dir.path(), "good", &[("prod", "c1", "u1")]);
        assert!(validate_file(&good).is_ok());
    }

    #[test]
    fn validate_file_reports_first_line_only() {
        let dir = tempfile::tempdir().unwrap();
        let bad = unparseable_file(dir.path());

        let err = validate_file(&bad).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Internal);
        assert!(err.message.contains("invalid kubeconfig"));
        assert!(!err.message.contains("abc"));
        assert!(!err.message.contains('\n'));

        let missing = validate_file(&dir.path().join("nope")).unwrap_err();
        assert_eq!(missing.kind, ErrorKind::NotFound);
    }

    #[test]
    fn a_path_already_loaded_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let a = kubeconfig_file(dir.path(), "a.yaml", &[("prod", "c1", "u1")]);
        let b = kubeconfig_file(dir.path(), "b.yaml", &[("dev", "c1", "u1")]);
        let err = ensure_not_loaded(&a, &[b.clone(), a.clone()]).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "a.yaml is already loaded");
        assert!(ensure_not_loaded(&a, &[b]).is_ok());
        assert!(ensure_not_loaded(&a, &[]).is_ok());
    }

    #[test]
    fn an_already_loaded_path_matches_through_another_spelling() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let a = kubeconfig_file(dir.path(), "a.yaml", &[("prod", "c1", "u1")]);
        let roundabout = dir.path().join("sub").join("..").join("a.yaml");
        assert!(ensure_not_loaded(&roundabout, std::slice::from_ref(&a)).is_err());
        assert!(ensure_not_loaded(&a, &[roundabout]).is_err());
        // A loaded path that does not exist (an unset default) still compares as written.
        let gone = dir.path().join("gone.yaml");
        assert!(ensure_not_loaded(&a, std::slice::from_ref(&gone)).is_ok());
        assert!(ensure_not_loaded(&gone, std::slice::from_ref(&gone)).is_err());
    }
}
