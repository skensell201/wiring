//! Which namespaces a session watches, and the watch streams that takes
//! (spec: docs/superpowers/specs/2026-10-06-multi-namespace-design.md).

use std::collections::BTreeSet;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::store::Kind;

/// The most namespaces an explicit set may name: each one costs a watch stream per kind (and a
/// metrics list per tick), so beyond this All namespaces is the cheaper choice.
pub const MAX_NAMESPACES: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamespaceScope {
    All,
    /// Never empty.
    Set(BTreeSet<String>),
}

impl NamespaceScope {
    /// One namespace, validated like a `select_namespaces` list of one.
    pub fn single(namespace: &str) -> AppResult<Self> {
        Self::from_arg(Some(vec![namespace.to_string()]))
    }

    /// The `select_namespaces` argument: `None` is all namespaces; a list is trimmed, deduplicated
    /// and must name between one and [`MAX_NAMESPACES`] valid namespaces.
    pub fn from_arg(namespaces: Option<Vec<String>>) -> AppResult<Self> {
        let Some(list) = namespaces else { return Ok(Self::All) };
        let set: BTreeSet<String> = list.into_iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
        if set.is_empty() {
            return Err(AppError::new(ErrorKind::Invalid, "pick at least one namespace"));
        }
        if set.len() > MAX_NAMESPACES {
            return Err(AppError::new(
                ErrorKind::Invalid,
                format!("pick up to {MAX_NAMESPACES} namespaces, or All namespaces"),
            ));
        }
        for ns in &set {
            crate::manifest::validate_dns_label("namespace", ns)?;
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
    fn namespaces_must_be_dns_labels_whichever_way_they_are_picked() {
        let label63 = "a".repeat(63);
        for ok in ["a", "team-a", "0ns", label63.as_str()] {
            assert!(NamespaceScope::from_arg(Some(vec![ok.into()])).is_ok(), "{ok}");
            assert!(NamespaceScope::single(ok).is_ok(), "{ok}");
        }
        let label64 = "a".repeat(64);
        for bad in ["a.b", "Team", "-a", "a-", "a_b", "a/b", label64.as_str(), ""] {
            let err = NamespaceScope::from_arg(Some(vec!["fine".into(), bad.into()]));
            if !bad.is_empty() {
                assert_eq!(err.unwrap_err().kind, ErrorKind::Invalid, "{bad}");
            }
            assert_eq!(NamespaceScope::single(bad).unwrap_err().kind, ErrorKind::Invalid, "{bad}");
        }
    }

    #[test]
    fn from_arg_caps_explicit_sets_at_twenty_namespaces() {
        let names = |n: usize| Some((0..n).map(|i| format!("ns-{i}")).collect::<Vec<_>>());
        assert!(matches!(NamespaceScope::from_arg(names(MAX_NAMESPACES)).unwrap(), NamespaceScope::Set(s) if s.len() == 20));
        let err = NamespaceScope::from_arg(names(MAX_NAMESPACES + 1)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "pick up to 20 namespaces, or All namespaces");
        // Duplicates collapse before the count.
        let mut dup = names(MAX_NAMESPACES).unwrap();
        dup.push("ns-0".into());
        assert!(NamespaceScope::from_arg(Some(dup)).is_ok());
    }

    #[test]
    fn multi_means_more_than_one_namespace() {
        assert!(NamespaceScope::All.is_multi());
        assert!(!NamespaceScope::single("shop").unwrap().is_multi());
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
        let one = watch_plan(&NamespaceScope::single("shop").unwrap());
        assert_eq!(one.len(), Kind::WATCHED.len());
        assert!(one.contains(&StreamId::namespaced(Kind::Pod, "shop")));
        assert!(one.contains(&StreamId::cluster(Kind::PersistentVolume)));

        let two = watch_plan(&NamespaceScope::from_arg(Some(vec!["a".into(), "b".into()])).unwrap());
        let cluster = Kind::WATCHED.iter().filter(|k| k.is_cluster_scoped()).count();
        assert_eq!(two.len(), (Kind::WATCHED.len() - cluster) * 2 + cluster);
        assert!(two.contains(&StreamId::namespaced(Kind::Secret, "a")));
        assert!(two.contains(&StreamId::namespaced(Kind::Secret, "b")));
        assert_eq!(two.iter().filter(|s| s.kind == Kind::PersistentVolume).count(), 1);

        let all = watch_plan(&NamespaceScope::All);
        assert_eq!(all.len(), Kind::WATCHED.len());
        assert!(all.iter().all(|s| s.namespace.is_none()));
    }
}
