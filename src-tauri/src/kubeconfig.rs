//! Discover kubeconfig files and the contexts they define.

use std::path::{Path, PathBuf};

use kube::config::Kubeconfig;
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

/// Only the first line of an error's `Display`, so raw parser output (which
/// may echo source tokens) never reaches the UI.
fn first_line(e: &impl std::fmt::Display) -> String {
    e.to_string().lines().next().unwrap_or_default().to_string()
}

pub fn split_env_paths(value: &str) -> Vec<PathBuf> {
    std::env::split_paths(value).filter(|p| !p.as_os_str().is_empty()).collect()
}

/// `$KUBECONFIG` entries if set, otherwise `~/.kube/config`.
pub fn default_paths() -> Vec<PathBuf> {
    if let Ok(env) = std::env::var("KUBECONFIG") {
        let paths = split_env_paths(&env);
        if !paths.is_empty() {
            return paths;
        }
    }
    dirs::home_dir().map(|h| vec![h.join(".kube").join("config")]).unwrap_or_default()
}

/// Reads every existing, parseable file. Missing files are skipped silently;
/// unreadable/unparseable files are skipped with a warning — neither aborts
/// the caller, since a single bad file shouldn't hide the rest.
fn read_existing(paths: &[PathBuf]) -> Vec<(PathBuf, Kubeconfig)> {
    let mut out = vec![];
    for p in paths {
        if !p.exists() {
            tracing::debug!(path = %p.display(), "kubeconfig not found, skipping");
            continue;
        }
        match Kubeconfig::read_from(p) {
            Ok(cfg) => out.push((p.clone(), cfg)),
            Err(e) => {
                tracing::warn!(path = %p.display(), error = %first_line(&e), "skipping unreadable kubeconfig");
            }
        }
    }
    out
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
        merged = merged
            .merge(cfg)
            .map_err(|e| AppError::new(ErrorKind::Internal, format!("merging {}: {}", path.display(), first_line(&e))))?;
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
pub fn validate_file(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::new(ErrorKind::NotFound, format!("{} does not exist", path.display())));
    }
    if let Err(e) = Kubeconfig::read_from(path) {
        return Err(AppError::new(
            ErrorKind::Internal,
            format!("{}: invalid kubeconfig ({})", path.display(), first_line(&e)),
        ));
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
}
