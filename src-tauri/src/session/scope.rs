//! Which namespaces a session watches, and the watch streams that takes
//! (spec: docs/superpowers/specs/2026-10-06-multi-namespace-design.md).

use std::collections::BTreeSet;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::store::Kind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamespaceScope {
    All,
    /// Never empty.
    Set(BTreeSet<String>),
}

impl NamespaceScope {
    pub fn single(namespace: &str) -> Self {
        Self::Set(BTreeSet::from([namespace.to_string()]))
    }

    /// The `select_namespaces` argument: `None` is all namespaces; a list is trimmed, deduplicated
    /// and must name at least one valid namespace.
    pub fn from_arg(namespaces: Option<Vec<String>>) -> AppResult<Self> {
        let Some(list) = namespaces else { return Ok(Self::All) };
        let set: BTreeSet<String> = list.into_iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
        if set.is_empty() {
            return Err(AppError::new(ErrorKind::Invalid, "pick at least one namespace"));
        }
        for ns in &set {
            crate::manifest::validate_dns_subdomain("namespace", ns)?;
        }
        Ok(Self::Set(set))
    }

    /// More than one namespace on screen: tables get a Namespace column, the graph gets lanes.
    pub fn is_multi(&self) -> bool {
        match self {
            Self::All => true,
            Self::Set(set) => set.len() > 1,
        }
    }
}

/// One watch stream: a kind in one namespace, or cluster-wide (`namespace: None`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StreamId {
    pub kind: Kind,
    pub namespace: Option<String>,
}

impl StreamId {
    pub fn cluster(kind: Kind) -> Self {
        Self { kind, namespace: None }
    }

    pub fn namespaced(kind: Kind, namespace: &str) -> Self {
        Self {
            kind,
            namespace: Some(namespace.to_string()),
        }
    }

    /// Whether an object of this stream's kind in `namespace` comes from this stream.
    pub fn covers(&self, namespace: Option<&str>) -> bool {
        self.namespace.is_none() || self.namespace.as_deref() == namespace
    }
}

impl From<Kind> for StreamId {
    fn from(kind: Kind) -> Self {
        Self::cluster(kind)
    }
}

/// The streams `scope` needs: PersistentVolumes are always one cluster-wide stream; every other
/// kind is one cluster-wide stream for `All`, or one per namespace for a set.
pub fn watch_plan(scope: &NamespaceScope) -> Vec<StreamId> {
    let mut plan = Vec::new();
    for kind in Kind::WATCHED {
        match scope {
            _ if kind.is_cluster_scoped() => plan.push(StreamId::cluster(kind)),
            NamespaceScope::All => plan.push(StreamId::cluster(kind)),
            NamespaceScope::Set(set) => plan.extend(set.iter().map(|ns| StreamId::namespaced(kind, ns))),
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    #[test]
    fn from_arg_reads_all_and_sets() {
        assert_eq!(NamespaceScope::from_arg(None).unwrap(), NamespaceScope::All);
        let s = NamespaceScope::from_arg(Some(vec![" shop ".into(), "blog".into(), "shop".into()])).unwrap();
        assert_eq!(
            s,
            NamespaceScope::Set(["blog".to_string(), "shop".to_string()].into_iter().collect())
        );
        assert_eq!(NamespaceScope::from_arg(Some(vec![])).unwrap_err().kind, ErrorKind::Invalid);
        assert_eq!(
            NamespaceScope::from_arg(Some(vec!["  ".into()])).unwrap_err().kind,
            ErrorKind::Invalid
        );
        assert_eq!(
            NamespaceScope::from_arg(Some(vec!["Bad/ns".into()])).unwrap_err().kind,
            ErrorKind::Invalid
        );
    }

    #[test]
    fn multi_means_more_than_one_namespace() {
        assert!(NamespaceScope::All.is_multi());
        assert!(!NamespaceScope::single("shop").is_multi());
        assert!(NamespaceScope::from_arg(Some(vec!["a".into(), "b".into()])).unwrap().is_multi());
    }

    #[test]
    fn a_stream_covers_its_namespace_or_everything() {
        assert!(StreamId::cluster(Kind::Pod).covers(Some("x")));
        assert!(StreamId::cluster(Kind::PersistentVolume).covers(None));
        assert!(StreamId::namespaced(Kind::Pod, "a").covers(Some("a")));
        assert!(!StreamId::namespaced(Kind::Pod, "a").covers(Some("b")));
        assert_eq!(StreamId::from(Kind::Pod), StreamId::cluster(Kind::Pod));
    }

    #[test]
    fn plan_is_per_namespace_for_sets_and_cluster_wide_for_all() {
        let one = watch_plan(&NamespaceScope::single("shop"));
        assert_eq!(one.len(), Kind::WATCHED.len());
        assert!(one.contains(&StreamId::namespaced(Kind::Pod, "shop")));
        assert!(one.contains(&StreamId::cluster(Kind::PersistentVolume)));

        let two = watch_plan(&NamespaceScope::from_arg(Some(vec!["a".into(), "b".into()])).unwrap());
        assert_eq!(two.len(), (Kind::WATCHED.len() - 1) * 2 + 1);
        assert!(two.contains(&StreamId::namespaced(Kind::Secret, "a")));
        assert!(two.contains(&StreamId::namespaced(Kind::Secret, "b")));
        assert_eq!(two.iter().filter(|s| s.kind == Kind::PersistentVolume).count(), 1);

        let all = watch_plan(&NamespaceScope::All);
        assert_eq!(all.len(), Kind::WATCHED.len());
        assert!(all.iter().all(|s| s.namespace.is_none()));
    }
}
