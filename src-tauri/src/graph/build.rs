//! Store -> Graph. Pure and deterministic.

use std::collections::{BTreeMap, HashMap, HashSet};

use super::model::{node_id, Edge, Graph, GroupInfo, Node, NodeId, Problem, Relation, Status};
use super::relations::all_edges;
use super::status::{describe_with, problem as own_problem, PolicyPods};
use crate::metrics::usage::PodIndex;
use crate::store::{Kind, Object, ObjectKey, Store};

#[derive(Debug, Clone)]
pub struct BuildOptions {
    pub expanded_groups: HashSet<NodeId>,
    /// Collapse pods of one owner when there are more than this many.
    pub group_threshold: usize,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            expanded_groups: HashSet::new(),
            group_threshold: 5,
        }
    }
}

pub fn build(store: &Store, opts: &BuildOptions) -> Graph {
    let mut nodes: HashMap<NodeId, Node> = HashMap::new();
    let pods = PodIndex::new(store);
    let policy_pods = PolicyPods::new(store, store.iter_kind(Kind::Pod));
    for obj in store.iter() {
        // Must run before `hide_single_replicasets`, which counts a Deployment's *remaining*
        // ReplicaSet children: a stale RS has to be excluded from that count, not hidden by it.
        if is_stale_replicaset(obj) {
            continue;
        }
        let (status, badges) = describe_with(obj, store, &pods, &policy_pods);
        let problem = own_problem(obj, status, store);
        let id = node_id(obj.kind(), obj.namespace(), obj.name());
        nodes.insert(
            id.clone(),
            Node {
                id,
                kind: obj.kind(),
                namespace: obj.namespace().map(str::to_owned),
                name: obj.name().to_owned(),
                status,
                badges,
                group: None,
                problem,
            },
        );
    }

    let (custom_nodes, custom_edges) = custom_owners(store, &nodes);
    for n in custom_nodes {
        nodes.insert(n.id.clone(), n);
    }

    let mut edges: Vec<Edge> = all_edges(store)
        .into_iter()
        .chain(custom_edges)
        .filter(|e| nodes.contains_key(&e.source) && nodes.contains_key(&e.target))
        .collect();

    retain_bound_persistent_volumes(&mut nodes, &edges);
    retain_connected_cluster_objects(&mut nodes, &mut edges);

    hide_single_replicasets(&mut nodes, &mut edges);
    collapse_pod_groups(&mut nodes, &mut edges, opts);
    // On the final nodes and edges, so every cause names a visible node.
    link_causes(&mut nodes, &edges);

    // Re-pointing in `hide_single_replicasets`/`collapse_pod_groups` can leave duplicate edge ids
    // (e.g. two re-pointed edges now sharing source/target/relation); `normalize()`'s dedup is
    // load-bearing here, not cosmetic.
    let mut graph = Graph {
        nodes: nodes.into_values().collect(),
        edges,
        too_large: None,
    };
    graph.normalize();
    graph
}

/// Owners that are custom resources (an ownerReference whose kind is not built in) as neutral
/// `Custom` nodes, one per owner, with an `owns` edge to each child on the graph. Custom
/// resources are not watched, so their status is unknown; their details load on demand.
/// A reference that would not make a parseable custom id (malformed data) is skipped.
fn custom_owners(store: &Store, nodes: &HashMap<NodeId, Node>) -> (Vec<Node>, Vec<Edge>) {
    use crate::custom::id::{custom_node_id, split_api_version, CustomId};
    let mut owners: BTreeMap<NodeId, Node> = BTreeMap::new();
    let mut edges = Vec::new();
    for obj in store.iter() {
        let child = node_id(obj.kind(), obj.namespace(), obj.name());
        if !nodes.contains_key(&child) {
            continue;
        }
        for r in obj.meta().owner_references.iter().flatten() {
            if Kind::parse(&r.kind).is_some() {
                continue;
            }
            let (group, version) = split_api_version(&r.api_version);
            let id = custom_node_id(group, version, &r.kind, obj.namespace(), &r.name);
            if CustomId::parse(&id).is_err() {
                continue;
            }
            owners.entry(id.clone()).or_insert_with(|| Node {
                id: id.clone(),
                kind: Kind::Custom,
                namespace: obj.namespace().map(str::to_owned),
                name: r.name.clone(),
                status: Status::Unknown,
                badges: Vec::new(),
                group: None,
                problem: None,
            });
            edges.push(Edge::new(&id, &child, Relation::Owns));
        }
    }
    (owners.into_values().collect(), edges)
}

/// Longest owner chain a pod can have to a watched controller (Pod -> ReplicaSet -> Deployment).
pub(crate) const OWNER_CHAIN_DEPTH: usize = 3;

/// The pods a `PodGroup/<ns>/<OwnerKind>/<owner>` node stands for: every pod in `<ns>` whose
/// `ownerReferences` chain reaches `<owner>` — directly (ReplicaSet, StatefulSet, DaemonSet,
/// Job) or through a hidden ReplicaSet (Deployment). Sorted by name; empty when the id is
/// malformed or nothing is owned by that controller.
///
/// For a Deployment this follows every ReplicaSet, so pods still terminating under an old,
/// scaled-down revision are included too (the graph drops such ReplicaSets, but their pods are
/// still the Deployment's). Deleting them is harmless: they are on their way out anyway.
pub fn group_members(store: &Store, group_id: &str) -> Vec<ObjectKey> {
    let Some((ns, owner_kind, owner_name)) = parse_group_id(group_id) else {
        return vec![];
    };
    let mut keys: Vec<ObjectKey> = store
        .iter_kind(Kind::Pod)
        .filter(|pod| pod.namespace() == Some(ns))
        .filter(|pod| is_owned_by(store, pod, owner_kind, owner_name, OWNER_CHAIN_DEPTH))
        .map(Object::key)
        .collect();
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    keys
}

fn parse_group_id(group_id: &str) -> Option<(&str, Kind, &str)> {
    let rest = group_id.strip_prefix("PodGroup/")?;
    let mut parts = rest.splitn(3, '/');
    let (ns, kind, name) = (parts.next()?, parts.next()?, parts.next()?);
    if ns.is_empty() || name.is_empty() {
        return None;
    }
    Some((ns, Kind::parse(kind)?, name))
}

/// Walk `obj`'s ownerReferences (only watched kinds) up to `depth` levels looking for
/// `<kind>/<name>` in the same namespace.
pub(crate) fn is_owned_by(store: &Store, obj: &Object, kind: Kind, name: &str, depth: usize) -> bool {
    if depth == 0 {
        return false;
    }
    obj.meta()
        .owner_references
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter_map(|r| Kind::parse(&r.kind).map(|k| (k, r.name.as_str())))
        .any(|(ref_kind, ref_name)| {
            (ref_kind == kind && ref_name == name)
                || store
                    .find(ref_kind, obj.namespace(), ref_name)
                    .is_some_and(|parent| is_owned_by(store, parent, kind, name, depth - 1))
        })
}

/// Old revisions: desired 0 and current 0.
fn is_stale_replicaset(obj: &Object) -> bool {
    let Object::ReplicaSet(rs) = obj else { return false };
    let desired = rs.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let current = rs.status.as_ref().map(|s| s.replicas).unwrap_or(0);
    desired == 0 && current == 0
}

/// PersistentVolume is watched cluster-wide, so every PV shows up regardless of the selected
/// namespace unless we filter it here. Keep a PV node only if it has a `binds` edge to a PVC
/// that is in the graph, i.e. bound to a claim in the selected namespace. Edges already only
/// reference existing nodes, and a removed PV has no edges by definition, so no edge cleanup is
/// needed here.
fn retain_bound_persistent_volumes(nodes: &mut HashMap<NodeId, Node>, edges: &[Edge]) {
    let bound: HashSet<&NodeId> = edges.iter().filter(|e| e.relation == Relation::Binds).map(|e| &e.source).collect();
    nodes.retain(|id, n| n.kind != Kind::PersistentVolume || bound.contains(id));
}

/// Cluster-scoped objects only appear when they touch the scope: a Node hosting a pod here, a
/// ClusterRoleBinding with a ServiceAccount subject here, a ClusterRole a shown binding grants.
/// Edges to what is dropped go too.
fn retain_connected_cluster_objects(nodes: &mut HashMap<NodeId, Node>, edges: &mut Vec<Edge>) {
    let kind_of = |id: &str| nodes.get(id).map(|n| n.kind);
    let hosting: HashSet<NodeId> = edges
        .iter()
        .filter(|e| e.relation == Relation::RunsOn)
        .map(|e| e.target.clone())
        .collect();
    let bound: HashSet<NodeId> = edges
        .iter()
        .filter(|e| e.relation == Relation::Subject && kind_of(&e.source) == Some(Kind::ClusterRoleBinding))
        .map(|e| e.source.clone())
        .collect();
    let granted: HashSet<NodeId> = edges
        .iter()
        .filter(|e| {
            e.relation == Relation::Grants
                && match kind_of(&e.source) {
                    Some(Kind::RoleBinding) => true,
                    Some(Kind::ClusterRoleBinding) => bound.contains(&e.source),
                    _ => false,
                }
        })
        .map(|e| e.target.clone())
        .collect();
    nodes.retain(|id, n| match n.kind {
        Kind::Node => hosting.contains(id),
        Kind::ClusterRoleBinding => bound.contains(id),
        Kind::ClusterRole => granted.contains(id),
        _ => true,
    });
    edges.retain(|e| nodes.contains_key(&e.source) && nodes.contains_key(&e.target));
}

/// A Deployment with exactly one ReplicaSet child: drop the RS node, re-point RS->X edges to the Deployment.
fn hide_single_replicasets(nodes: &mut HashMap<NodeId, Node>, edges: &mut Vec<Edge>) {
    let mut children: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
    for e in edges.iter() {
        if e.relation == Relation::Owns
            && nodes.get(&e.source).map(|n| n.kind) == Some(Kind::Deployment)
            && nodes.get(&e.target).map(|n| n.kind) == Some(Kind::ReplicaSet)
        {
            children.entry(e.source.clone()).or_default().push(e.target.clone());
        }
    }
    for (dep, rss) in children {
        if rss.len() != 1 {
            continue;
        }
        let rs = &rss[0];
        nodes.remove(rs);
        *edges = edges
            .drain(..)
            .filter(|e| !(e.source == dep && e.target == *rs))
            .map(|e| {
                let source = if e.source == *rs { dep.clone() } else { e.source };
                let target = if e.target == *rs { dep.clone() } else { e.target };
                Edge::new(source, target, e.relation)
            })
            .filter(|e| e.source != e.target)
            .collect();
    }
}

/// PodGroup badges: `×N` plus the ok/warn/err breakdown, omitted when every member is
/// `Unknown` (the breakdown would otherwise join into an empty string).
fn group_badges(info: &GroupInfo) -> Vec<String> {
    let mut badges = vec![format!("×{}", info.count)];
    let mut counts = vec![];
    if info.ok > 0 {
        counts.push(format!("{} ok", info.ok));
    }
    if info.warn > 0 {
        counts.push(format!("{} warn", info.warn));
    }
    if info.err > 0 {
        counts.push(format!("{} err", info.err));
    }
    if !counts.is_empty() {
        badges.push(counts.join(" · "));
    }
    badges
}

/// Collapse pods with the same immediate owner into a PodGroup node.
fn collapse_pod_groups(nodes: &mut HashMap<NodeId, Node>, edges: &mut Vec<Edge>, opts: &BuildOptions) {
    // owner id -> member pod ids
    let mut members: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
    for e in edges.iter() {
        let owner_kind = nodes.get(&e.source).map(|n| n.kind);
        // A PodGroup id names its owner as `<Kind>/<name>`, which a custom owner cannot be.
        if e.relation == Relation::Owns && nodes.get(&e.target).map(|n| n.kind) == Some(Kind::Pod) && owner_kind != Some(Kind::Custom) {
            members.entry(e.source.clone()).or_default().push(e.target.clone());
        }
    }

    let mut remap: HashMap<NodeId, NodeId> = HashMap::new();
    for (owner_id, pods) in members {
        if pods.len() <= opts.group_threshold {
            continue;
        }
        let (owner_ns, owner_kind, owner_name) = {
            let o = &nodes[&owner_id];
            (o.namespace.clone(), o.kind, o.name.clone())
        };
        let group_id = format!(
            "PodGroup/{}/{}/{}",
            owner_ns.as_deref().unwrap_or(""),
            owner_kind.as_str(),
            owner_name
        );
        if opts.expanded_groups.contains(&group_id) {
            continue;
        }
        let mut info = GroupInfo {
            count: 0,
            ok: 0,
            warn: 0,
            err: 0,
        };
        let mut worst = Status::Unknown;
        let mut collapsed: Vec<Node> = vec![];
        for pod_id in &pods {
            // A pod can carry more than one ownerReference (owner_edges walks all of them), so
            // the same pod id may appear under two different owners' member lists. Once it has
            // been collapsed into one group, it is no longer in `nodes`; skip it here instead of
            // panicking, and only count pods actually collapsed into *this* group.
            let Some(pod) = nodes.remove(pod_id) else { continue };
            info.count += 1;
            match pod.status {
                Status::Ok => info.ok += 1,
                Status::Warn => info.warn += 1,
                Status::Err => info.err += 1,
                Status::Unknown => {}
            }
            worst = worst.max(pod.status);
            remap.insert(pod_id.clone(), group_id.clone());
            collapsed.push(pod);
        }
        if info.count == 0 {
            continue;
        }
        let badges = group_badges(&info);
        let problem = group_problem(&collapsed, worst, info.count);
        nodes.insert(
            group_id.clone(),
            Node {
                id: group_id.clone(),
                kind: Kind::PodGroup,
                namespace: owner_ns,
                name: owner_name,
                status: worst,
                badges,
                group: Some(info),
                problem,
            },
        );
    }

    if remap.is_empty() {
        return;
    }
    *edges = edges
        .drain(..)
        .map(|e| {
            let source = remap.get(&e.source).cloned().unwrap_or(e.source);
            let target = remap.get(&e.target).cloned().unwrap_or(e.target);
            Edge::new(source, target, e.relation)
        })
        .collect();
}

/// `K of N pods: <reason>` for the most common reason among the worst-status members (ties go to
/// the alphabetically first reason), with the message of the first such member by name.
fn group_problem(members: &[Node], worst: Status, count: usize) -> Option<Problem> {
    if worst < Status::Warn {
        return None;
    }
    let mut by_reason: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for m in members.iter().filter(|m| m.status == worst) {
        if let Some(p) = &m.problem {
            by_reason.entry(p.reason.as_str()).or_default().push(m);
        }
    }
    let (reason, mut pods) = by_reason
        .into_iter()
        .fold(None, |best: Option<(&str, Vec<&Node>)>, (r, v)| match &best {
            Some((_, b)) if b.len() >= v.len() => best,
            _ => Some((r, v)),
        })?;
    pods.sort_by(|a, b| a.name.cmp(&b.name));
    let first = pods[0];
    let message = match first.problem.as_ref().and_then(|p| p.message.as_deref()) {
        Some(m) => format!("{}: {m}", first.name),
        None => first.name.clone(),
    };
    Some(Problem {
        reason: format!("{} of {count} pods: {reason}", pods.len()),
        message: Some(message),
        cause: None,
    })
}

/// Point each delegating problem at the neighbour to blame: the worst-status (Warn/Err) target of
/// a workload's `owns` edges or a Service's `selects` edges; ties go to the smallest id.
fn link_causes(nodes: &mut HashMap<NodeId, Node>, edges: &[Edge]) {
    let mut outgoing: HashMap<(&str, Relation), Vec<&str>> = HashMap::new();
    for e in edges {
        outgoing.entry((e.source.as_str(), e.relation)).or_default().push(e.target.as_str());
    }
    let links: Vec<(NodeId, NodeId)> = nodes
        .values()
        // A suspended CronJob is paused on purpose: its own problem, not its Jobs', is what to show.
        .filter(|n| {
            n.problem
                .as_ref()
                .is_some_and(|p| !(n.kind == Kind::CronJob && p.reason == "Suspended"))
        })
        .filter_map(|n| {
            let relation = match n.kind {
                Kind::Deployment | Kind::StatefulSet | Kind::DaemonSet | Kind::ReplicaSet | Kind::Job | Kind::CronJob => Relation::Owns,
                Kind::Service => Relation::Selects,
                // A pod stuck because its node is down: the node is the cause. Pods on a
                // NotReady node usually stay Running but not Ready, or hang in Terminating.
                Kind::Pod
                    if n.problem
                        .as_ref()
                        .is_some_and(|p| matches!(p.reason.as_str(), "Pending" | "Unknown" | "Not ready" | "Terminating")) =>
                {
                    Relation::RunsOn
                }
                _ => return None,
            };
            outgoing
                .get(&(n.id.as_str(), relation))?
                .iter()
                .filter_map(|t| nodes.get(*t))
                .filter(|t| {
                    if relation == Relation::RunsOn {
                        t.status == Status::Err
                    } else {
                        t.status >= Status::Warn
                    }
                })
                .max_by(|a, b| a.status.cmp(&b.status).then_with(|| b.id.cmp(&a.id)))
                .map(|t| (n.id.clone(), t.id.clone()))
        })
        .collect();
    for (id, cause) in links {
        if let Some(p) = nodes.get_mut(&id).and_then(|n| n.problem.as_mut()) {
            p.cause = Some(cause);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::{Problem, Status};
    use crate::store::{Kind, Store};

    #[test]
    fn a_pending_pod_on_a_not_ready_node_points_at_the_node() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let g = build(&s, &BuildOptions::default());
        let p = g
            .nodes
            .iter()
            .find(|n| n.id == "Pod/s/client-1")
            .and_then(|n| n.problem.as_ref())
            .unwrap();
        assert_eq!(p.cause.as_deref(), Some("Node//node-b"));
        let other = g.nodes.iter().find(|n| n.id == "Pod/t/other-1").and_then(|n| n.problem.as_ref());
        assert!(other.is_none_or(|p| p.cause.is_none()), "a healthy node causes nothing");
    }

    #[test]
    fn a_running_not_ready_or_terminating_pod_on_a_not_ready_node_points_at_the_node() {
        use crate::store::Object;
        use k8s_openapi::api::core::v1::{PodCondition, PodStatus};
        use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
        let base = Store::from_fixture("graph-extras").unwrap();
        let client = || {
            let Some(Object::Pod(p)) = base
                .iter_kind(Kind::Pod)
                .find(|o| o.meta().name.as_deref() == Some("client-1"))
                .cloned()
            else {
                panic!("client-1 in the fixture")
            };
            p
        };
        let cause = |pod| {
            let mut s = base.clone();
            s.upsert(Object::Pod(pod));
            let g = build(&s, &BuildOptions::default());
            let p = g
                .nodes
                .iter()
                .find(|n| n.id == "Pod/s/client-1")
                .and_then(|n| n.problem.clone())
                .unwrap();
            (p.reason, p.cause)
        };
        let mut running = client();
        running.status = Some(PodStatus {
            phase: Some("Running".into()),
            conditions: Some(vec![PodCondition {
                type_: "Ready".into(),
                status: "False".into(),
                ..Default::default()
            }]),
            ..Default::default()
        });
        assert_eq!(cause(running.clone()), ("Not ready".into(), Some("Node//node-b".into())));
        let mut terminating = running;
        terminating.metadata.deletion_timestamp = Some(Time("2026-10-06T10:00:00Z".parse().unwrap()));
        assert_eq!(cause(terminating), ("Terminating".into(), Some("Node//node-b".into())));
    }

    #[test]
    fn the_policy_badge_comes_from_the_shared_precomputed_set() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let g = build(&s, &BuildOptions::default());
        let badged = |id: &str| g.node(id).unwrap().badges.contains(&"policy".to_string());
        assert!(badged("Pod/s/web-1") && badged("Pod/s/client-1"));
        assert!(!badged("Pod/t/other-1"));
    }

    fn edge_ids(g: &Graph) -> Vec<&str> {
        g.edges.iter().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn cluster_scoped_rbac_and_nodes_only_show_when_connected() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let g = build(&s, &BuildOptions::default());
        let has = |id: &str| g.node(id).is_some();
        assert!(has("Node//node-a") && has("Node//node-b"), "nodes hosting pods stay");
        assert!(!has("Node//node-c"), "a node without pods here is hidden");
        assert!(has("ClusterRoleBinding//web-cluster"), "binds a ServiceAccount in the scope");
        assert!(!has("ClusterRoleBinding//system-only"), "only Group subjects");
        assert!(has("ClusterRole//view"), "granted by shown bindings");
        assert!(!has("ClusterRole//unused"), "only granted by a hidden binding");
        assert!(
            g.edges.iter().all(|e| g.node(&e.source).is_some() && g.node(&e.target).is_some()),
            "no dangling edges"
        );
    }

    #[test]
    fn policy_and_node_edges_retarget_to_pod_groups() {
        let s = Store::from_fixture("graph-extras-group").unwrap();
        let group = "PodGroup/g/Deployment/api";
        let g = build(&s, &BuildOptions::default());
        let ids = edge_ids(&g);
        for e in [
            format!("NetworkPolicy/g/api-ingress->{group}:applies"),
            format!("{group}->NetworkPolicy/g/api-ingress:allows"),
            format!("{group}->Node//node-a:runsOn"),
        ] {
            assert_eq!(ids.iter().filter(|i| **i == e).count(), 1, "{e} in {ids:?}");
        }

        let opts = BuildOptions {
            expanded_groups: [group.to_string()].into(),
            ..Default::default()
        };
        let g = build(&s, &opts);
        let ids = edge_ids(&g);
        assert!(g.node(group).is_none());
        for n in 1..=6 {
            let pod = format!("Pod/g/api-1-p{n}");
            for e in [
                format!("NetworkPolicy/g/api-ingress->{pod}:applies"),
                format!("{pod}->NetworkPolicy/g/api-ingress:allows"),
                format!("{pod}->Node//node-a:runsOn"),
            ] {
                assert_eq!(ids.iter().filter(|i| **i == e).count(), 1, "{e} in {ids:?}");
            }
        }
    }

    #[test]
    fn group_badges_omits_empty_breakdown() {
        assert_eq!(
            group_badges(&GroupInfo {
                count: 3,
                ok: 0,
                warn: 0,
                err: 0
            }),
            vec!["×3".to_string()]
        );
        assert_eq!(
            group_badges(&GroupInfo {
                count: 7,
                ok: 6,
                warn: 0,
                err: 1
            }),
            vec!["×7".to_string(), "6 ok · 1 err".to_string()]
        );
    }

    #[test]
    fn basic_deployment_hides_single_active_replicaset() {
        let s = Store::from_fixture("deployment-basic").unwrap();
        let g = build(&s, &BuildOptions::default());
        let kinds: Vec<Kind> = g.nodes.iter().map(|n| n.kind).collect();
        assert!(!kinds.contains(&Kind::ReplicaSet), "single active RS must be hidden");
        assert_eq!(g.nodes.len(), 3);
        assert_eq!(
            edge_ids(&g),
            vec![
                "Deployment/payments/web->Pod/payments/web-7f9c-aaaaa:owns",
                "Deployment/payments/web->Pod/payments/web-7f9c-bbbbb:owns",
            ]
        );
    }

    #[test]
    fn old_replicasets_are_dropped_and_pods_collapse_into_group() {
        let s = Store::from_fixture("podgroup").unwrap();
        let g = build(&s, &BuildOptions::default());
        assert!(g.node("ReplicaSet/g/api-old").is_none(), "scaled-to-zero RS omitted");
        assert!(g.node("ReplicaSet/g/api-new").is_none(), "single remaining RS hidden");
        assert!(g.nodes.iter().all(|n| n.kind != Kind::Pod), "pods collapsed");
        let group = g.node("PodGroup/g/Deployment/api").expect("group node");
        assert_eq!(group.status, Status::Err);
        assert_eq!(
            group.group,
            Some(GroupInfo {
                count: 7,
                ok: 6,
                warn: 0,
                err: 1
            })
        );
        assert_eq!(group.badges, vec!["×7", "6 ok · 1 err"]);
        assert_eq!(
            edge_ids(&g),
            vec![
                "ConfigMap/g/api-cfg->PodGroup/g/Deployment/api:envFrom",
                "Deployment/g/api->PodGroup/g/Deployment/api:owns",
                "HorizontalPodAutoscaler/g/rs-hpa->Deployment/g/api:scales",
                "Service/g/api->PodGroup/g/Deployment/api:selects",
            ]
        );
    }

    #[test]
    fn expanded_group_shows_individual_pods() {
        let s = Store::from_fixture("podgroup").unwrap();
        let opts = BuildOptions {
            expanded_groups: ["PodGroup/g/Deployment/api".to_string()].into_iter().collect(),
            ..Default::default()
        };
        let g = build(&s, &opts);
        assert!(g.node("PodGroup/g/Deployment/api").is_none());
        assert_eq!(g.nodes.iter().filter(|n| n.kind == Kind::Pod).count(), 7);
        assert!(g.edges.iter().any(|e| e.id == "Deployment/g/api->Pod/g/api-new-7:owns"));
    }

    #[test]
    fn threshold_is_strictly_greater_than() {
        let s = Store::from_fixture("podgroup").unwrap();
        let opts = BuildOptions {
            group_threshold: 7,
            ..Default::default()
        };
        let g = build(&s, &opts);
        assert!(
            g.node("PodGroup/g/Deployment/api").is_none(),
            "7 pods with threshold 7 stay expanded"
        );
    }

    #[test]
    fn output_is_normalized_and_deterministic() {
        let s = Store::from_fixture("relations").unwrap();
        let a = build(&s, &BuildOptions::default());
        let b = build(&s, &BuildOptions::default());
        assert_eq!(a, b);
        let ids: Vec<&str> = a.nodes.iter().map(|n| n.id.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }

    #[test]
    fn mid_rollout_keeps_both_replicasets() {
        let s = Store::from_fixture("rollout").unwrap();
        let g = build(&s, &BuildOptions::default());
        assert!(g.node("ReplicaSet/x/web-a").is_some(), "web-a must stay visible mid-rollout");
        assert!(g.node("ReplicaSet/x/web-b").is_some(), "web-b must stay visible mid-rollout");
        assert!(g.edges.iter().any(|e| e.id == "Deployment/x/web->ReplicaSet/x/web-a:owns"));
        assert!(
            g.edges.iter().any(|e| e.id == "ReplicaSet/x/web-a->Pod/x/web-a-1:owns"),
            "no pass-through when >1 RS remains"
        );
    }

    #[test]
    fn unbound_persistent_volumes_are_dropped() {
        let mut s = Store::from_fixture("relations").unwrap();
        let orphan = crate::store::Object::from_json_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "PersistentVolume",
            "metadata": { "name": "pv-orphan" },
            "spec": {
                "capacity": { "storage": "1Gi" },
                "accessModes": ["ReadWriteOnce"]
            }
        }))
        .unwrap();
        s.upsert(orphan);

        let g = build(&s, &BuildOptions::default());
        assert!(g.node("PersistentVolume//pv-data").is_some(), "bound PV must stay visible");
        assert!(
            g.node("PersistentVolume//pv-orphan").is_none(),
            "unbound PV from another namespace must not appear"
        );
        for e in &g.edges {
            assert!(g.node(&e.source).is_some(), "edge {} has dangling source", e.id);
            assert!(g.node(&e.target).is_some(), "edge {} has dangling target", e.id);
        }
    }

    #[test]
    fn group_members_follow_the_owner_chain_to_the_deployment() {
        let s = Store::from_fixture("podgroup").unwrap();
        let names = |id: &str| {
            group_members(&s, id)
                .into_iter()
                .map(|k| {
                    assert_eq!(k.kind, Kind::Pod);
                    assert_eq!(k.namespace.as_deref(), Some("g"));
                    k.name
                })
                .collect::<Vec<_>>()
        };
        let expected: Vec<String> = (1..=7).map(|i| format!("api-new-{i}")).collect();
        assert_eq!(names("PodGroup/g/Deployment/api"), expected, "via the hidden ReplicaSet");
        assert_eq!(names("PodGroup/g/ReplicaSet/api-new"), expected, "direct owner");
        assert!(names("PodGroup/g/ReplicaSet/api-old").is_empty(), "scaled-to-zero RS owns nothing");
    }

    #[test]
    fn group_members_is_empty_for_unknown_or_malformed_groups() {
        let s = Store::from_fixture("podgroup").unwrap();
        assert!(group_members(&s, "PodGroup/g/Deployment/nope").is_empty());
        assert!(
            group_members(&s, "PodGroup/other/Deployment/api").is_empty(),
            "namespace must match"
        );
        assert!(group_members(&s, "PodGroup/g/Node/api").is_empty(), "unwatched owner kind");
        assert!(group_members(&s, "Deployment/g/api").is_empty(), "not a group id");
        assert!(group_members(&s, "PodGroup/g/Deployment").is_empty(), "missing owner name");
    }

    #[test]
    fn every_edge_endpoint_exists() {
        let expanded = BuildOptions {
            expanded_groups: ["PodGroup/g/Deployment/api".to_string()].into_iter().collect(),
            ..Default::default()
        };
        for (fixture, opts) in [
            ("deployment-basic", BuildOptions::default()),
            ("relations", BuildOptions::default()),
            ("podgroup", BuildOptions::default()),
            ("podgroup", expanded),
        ] {
            let s = Store::from_fixture(fixture).unwrap();
            let g = build(&s, &opts);
            for e in &g.edges {
                assert!(g.node(&e.source).is_some(), "{fixture}: edge {} has dangling source", e.id);
                assert!(g.node(&e.target).is_some(), "{fixture}: edge {} has dangling target", e.id);
            }
        }
    }

    fn problem<'a>(g: &'a Graph, id: &str) -> Option<&'a Problem> {
        g.node(id).and_then(|n| n.problem.as_ref())
    }

    #[test]
    fn a_workload_points_at_its_failing_pod_group() {
        let s = Store::from_fixture("podgroup").unwrap();
        let g = build(&s, &BuildOptions::default());
        assert_eq!(
            problem(&g, "Deployment/g/api"),
            Some(&Problem {
                reason: "1 of 7 not ready".into(),
                message: None,
                cause: Some("PodGroup/g/Deployment/api".into()),
            })
        );
        assert_eq!(
            problem(&g, "PodGroup/g/Deployment/api"),
            Some(&Problem {
                reason: "1 of 7 pods: CrashLoopBackOff".into(),
                message: Some("api-new-7".into()),
                cause: None,
            })
        );
        // Six ready pods behind it: the Service is fine.
        assert_eq!(problem(&g, "Service/g/api"), None);
    }

    #[test]
    fn an_expanded_group_lets_the_cause_name_the_pod() {
        let s = Store::from_fixture("podgroup").unwrap();
        let opts = BuildOptions {
            expanded_groups: ["PodGroup/g/Deployment/api".to_string()].into_iter().collect(),
            ..Default::default()
        };
        let g = build(&s, &opts);
        assert_eq!(
            problem(&g, "Deployment/g/api").and_then(|p| p.cause.as_deref()),
            Some("Pod/g/api-new-7")
        );
        assert_eq!(problem(&g, "Pod/g/api-new-7").map(|p| p.reason.as_str()), Some("CrashLoopBackOff"));
    }

    #[test]
    fn healthy_graphs_carry_no_problems() {
        let s = Store::from_fixture("deployment-basic").unwrap();
        let g = build(&s, &BuildOptions::default());
        assert!(g.nodes.iter().all(|n| n.problem.is_none()), "{:#?}", g.nodes);
    }

    #[test]
    fn equal_culprits_resolve_to_the_smallest_id() {
        let s = Store::from_yaml_docs(
            r#"
apiVersion: apps/v1
kind: Deployment
metadata: { name: tie, namespace: t, uid: dep-tie }
spec:
  replicas: 2
  selector: { matchLabels: { app: tie } }
  template: { metadata: { labels: { app: tie } }, spec: { containers: [ { name: c, image: x } ] } }
status: { replicas: 2, readyReplicas: 0 }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata: { name: tie-1, namespace: t, uid: rs-tie, ownerReferences: [ { apiVersion: apps/v1, kind: Deployment, name: tie, uid: dep-tie, controller: true } ] }
spec:
  replicas: 2
  selector: { matchLabels: { app: tie } }
  template: { metadata: { labels: { app: tie } }, spec: { containers: [ { name: c, image: x } ] } }
status: { replicas: 2, readyReplicas: 0 }
---
apiVersion: v1
kind: Pod
metadata: { name: tie-1-b, namespace: t, labels: { app: tie }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: tie-1, uid: rs-tie, controller: true } ] }
spec: { containers: [ { name: c, image: x } ] }
status: { phase: Pending, containerStatuses: [ { name: c, ready: false, restartCount: 0, image: x, imageID: "", state: { waiting: { reason: ErrImagePull } } } ] }
---
apiVersion: v1
kind: Pod
metadata: { name: tie-1-a, namespace: t, labels: { app: tie }, ownerReferences: [ { apiVersion: apps/v1, kind: ReplicaSet, name: tie-1, uid: rs-tie, controller: true } ] }
spec: { containers: [ { name: c, image: x } ] }
status: { phase: Pending, containerStatuses: [ { name: c, ready: false, restartCount: 0, image: x, imageID: "", state: { waiting: { reason: ErrImagePull } } } ] }
"#,
        )
        .unwrap();
        let g = build(&s, &BuildOptions::default());
        assert_eq!(
            problem(&g, "Deployment/t/tie").and_then(|p| p.cause.as_deref()),
            Some("Pod/t/tie-1-a")
        );
    }

    #[test]
    fn group_reason_is_the_most_common_one_among_the_worst_pods() {
        let pod = |name: &str, status: Status, reason: &str, message: Option<&str>| Node {
            id: format!("Pod/g/{name}"),
            kind: Kind::Pod,
            namespace: Some("g".into()),
            name: name.into(),
            status,
            badges: vec![],
            group: None,
            problem: Some(Problem {
                reason: reason.into(),
                message: message.map(str::to_owned),
                cause: None,
            }),
        };
        let members = vec![
            pod("c", Status::Err, "OOMKilled", None),
            pod(
                "b",
                Status::Err,
                "CrashLoopBackOff",
                Some("container api: last exit code 1 (Error)"),
            ),
            pod("a", Status::Err, "CrashLoopBackOff", None),
            pod("d", Status::Warn, "Not ready", None),
        ];
        assert_eq!(
            group_problem(&members, Status::Err, 6),
            Some(Problem {
                reason: "2 of 6 pods: CrashLoopBackOff".into(),
                message: Some("a".into()),
                cause: None,
            })
        );
        // Ties go to the alphabetically first reason.
        let tie = vec![
            pod("x", Status::Err, "OOMKilled", None),
            pod("y", Status::Err, "Error", Some("container c: exit code 2")),
        ];
        assert_eq!(
            group_problem(&tie, Status::Err, 2).map(|p| (p.reason, p.message)),
            Some(("1 of 2 pods: Error".into(), Some("y: container c: exit code 2".into())))
        );
        assert_eq!(group_problem(&members, Status::Ok, 6), None);
    }

    #[test]
    fn a_suspended_cronjob_has_no_cause_even_with_a_failing_job() {
        let node = |id: &str, kind: Kind, status: Status, reason: &str| Node {
            id: id.into(),
            kind,
            namespace: Some("c".into()),
            name: id.rsplit('/').next().unwrap().into(),
            status,
            badges: vec![],
            group: None,
            problem: Some(Problem {
                reason: reason.into(),
                message: None,
                cause: None,
            }),
        };
        let mut nodes: HashMap<NodeId, Node> = [
            node("CronJob/c/nightly", Kind::CronJob, Status::Warn, "Suspended"),
            node("Job/c/nightly-1", Kind::Job, Status::Err, "BackoffLimitExceeded"),
            node("CronJob/c/live", Kind::CronJob, Status::Warn, "Failing"),
        ]
        .into_iter()
        .map(|n| (n.id.clone(), n))
        .collect();
        let edge = |s: &str| Edge {
            id: format!("{s}->Job/c/nightly-1:owns"),
            source: s.into(),
            target: "Job/c/nightly-1".into(),
            relation: Relation::Owns,
        };
        link_causes(&mut nodes, &[edge("CronJob/c/nightly"), edge("CronJob/c/live")]);
        assert_eq!(nodes["CronJob/c/nightly"].problem.as_ref().unwrap().cause, None);
        assert_eq!(
            nodes["CronJob/c/live"].problem.as_ref().unwrap().cause.as_deref(),
            Some("Job/c/nightly-1")
        );
    }

    fn failing_pods(n: usize, ns: &str, owner_kind: &str, owner: &str, uid: &str, label: &str) -> String {
        (0..n)
            .map(|i| {
                format!(
                    r#"---
apiVersion: v1
kind: Pod
metadata: {{ name: {owner}-p{i}, namespace: {ns}, labels: {{ app: {label} }}, ownerReferences: [ {{ apiVersion: apps/v1, kind: {owner_kind}, name: {owner}, uid: {uid}, controller: true }} ] }}
spec: {{ containers: [ {{ name: c, image: x }} ] }}
status: {{ phase: Pending, conditions: [ {{ type: Ready, status: "False" }} ], containerStatuses: [ {{ name: c, ready: false, restartCount: 0, image: x, imageID: "", state: {{ waiting: {{ reason: ErrImagePull }} }} }} ] }}
"#
                )
            })
            .collect()
    }

    fn deployment_yaml(name: &str, ns: &str, uid: &str, status: &str) -> String {
        format!(
            r#"---
apiVersion: apps/v1
kind: Deployment
metadata: {{ name: {name}, namespace: {ns}, uid: {uid} }}
spec:
  replicas: 2
  selector: {{ matchLabels: {{ app: {name} }} }}
  template: {{ metadata: {{ labels: {{ app: {name} }} }}, spec: {{ containers: [ {{ name: c, image: x }} ] }} }}
status: {status}
"#
        )
    }

    fn replicaset_yaml(name: &str, ns: &str, uid: &str, dep: &str, dep_uid: &str, ready: u32) -> String {
        format!(
            r#"---
apiVersion: apps/v1
kind: ReplicaSet
metadata: {{ name: {name}, namespace: {ns}, uid: {uid}, ownerReferences: [ {{ apiVersion: apps/v1, kind: Deployment, name: {dep}, uid: {dep_uid}, controller: true }} ] }}
spec:
  replicas: 2
  selector: {{ matchLabels: {{ app: {dep} }} }}
  template: {{ metadata: {{ labels: {{ app: {dep} }} }}, spec: {{ containers: [ {{ name: c, image: x }} ] }} }}
status: {{ replicas: 2, readyReplicas: {ready} }}
"#
        )
    }

    fn service_yaml(name: &str, ns: &str, label: &str) -> String {
        format!(
            "---\napiVersion: v1\nkind: Service\nmetadata: {{ name: {name}, namespace: {ns} }}\nspec: {{ selector: {{ app: {label} }}, ports: [ {{ port: 80 }} ] }}\n"
        )
    }

    #[test]
    fn a_service_points_at_its_worst_unready_pod() {
        let yaml = format!(
            "{}{}",
            service_yaml("svc", "s", "web"),
            failing_pods(2, "s", "ReplicaSet", "orphan", "u", "web")
        );
        let g = build(&Store::from_yaml_docs(&yaml).unwrap(), &BuildOptions::default());
        let p = problem(&g, "Service/s/svc").expect("service has a problem");
        assert_eq!(p.cause.as_deref(), Some("Pod/s/orphan-p0"), "ties go to the smallest id");
    }

    #[test]
    fn a_service_points_at_the_pod_group_when_pods_collapse() {
        let yaml = format!(
            "{}{}{}",
            service_yaml("svc", "s", "web"),
            replicaset_yaml("orphan", "s", "u", "nodep", "x", 0),
            failing_pods(7, "s", "ReplicaSet", "orphan", "u", "web")
        );
        let g = build(&Store::from_yaml_docs(&yaml).unwrap(), &BuildOptions::default());
        let cause = problem(&g, "Service/s/svc").and_then(|p| p.cause.as_deref());
        assert_eq!(cause, Some("PodGroup/s/ReplicaSet/orphan"));
        assert!(g.node(cause.unwrap()).is_some());
    }

    #[test]
    fn progress_deadline_exceeded_still_points_at_the_failing_pods() {
        let status = r#"{ replicas: 2, readyReplicas: 0, conditions: [ { type: Progressing, status: "False", reason: ProgressDeadlineExceeded, message: "timed out" } ] }"#;
        let yaml = format!(
            "{}{}{}",
            deployment_yaml("dl", "d", "dep-dl", status),
            replicaset_yaml("dl-1", "d", "rs-dl", "dl", "dep-dl", 0),
            failing_pods(2, "d", "ReplicaSet", "dl-1", "rs-dl", "dl")
        );
        let g = build(&Store::from_yaml_docs(&yaml).unwrap(), &BuildOptions::default());
        let p = problem(&g, "Deployment/d/dl").expect("deployment has a problem");
        assert_eq!(p.reason, "ProgressDeadlineExceeded");
        assert_eq!(p.cause.as_deref(), Some("Pod/d/dl-1-p0"));

        let yaml = format!(
            "{}{}{}",
            deployment_yaml("dl", "d", "dep-dl", status),
            replicaset_yaml("dl-1", "d", "rs-dl", "dl", "dep-dl", 0),
            failing_pods(7, "d", "ReplicaSet", "dl-1", "rs-dl", "dl")
        );
        let g = build(&Store::from_yaml_docs(&yaml).unwrap(), &BuildOptions::default());
        let cause = problem(&g, "Deployment/d/dl").and_then(|p| p.cause.as_deref());
        assert_eq!(cause, Some("PodGroup/d/Deployment/dl"));
        assert!(g.node(cause.unwrap()).is_some());
    }

    #[test]
    fn a_rollout_points_at_the_worse_visible_replicaset() {
        let yaml = format!(
            "{}{}{}{}",
            deployment_yaml("ro", "r", "dep-ro", "{ replicas: 2, readyReplicas: 1 }"),
            replicaset_yaml("ro-a", "r", "rs-a", "ro", "dep-ro", 2),
            replicaset_yaml("ro-b", "r", "rs-b", "ro", "dep-ro", 0),
            failing_pods(2, "r", "ReplicaSet", "ro-b", "rs-b", "ro")
        );
        let g = build(&Store::from_yaml_docs(&yaml).unwrap(), &BuildOptions::default());
        assert!(g.node("ReplicaSet/r/ro-a").is_some() && g.node("ReplicaSet/r/ro-b").is_some());
        assert!(g.node("ReplicaSet/r/ro-b").unwrap().status >= Status::Warn);
        assert_eq!(g.node("ReplicaSet/r/ro-a").unwrap().status, Status::Ok);
        assert_eq!(
            problem(&g, "Deployment/r/ro").and_then(|p| p.cause.as_deref()),
            Some("ReplicaSet/r/ro-b")
        );
    }

    fn obj(v: serde_json::Value) -> crate::store::Object {
        crate::store::Object::from_json_value(v).unwrap()
    }

    fn owned_secret(name: &str, owner_kind: &str, owner_api: &str, owner: &str) -> crate::store::Object {
        obj(serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": name, "namespace": "s", "ownerReferences": [
                { "apiVersion": owner_api, "kind": owner_kind, "name": owner, "uid": format!("uid-{owner}") }
            ] }
        }))
    }

    #[test]
    fn a_custom_resource_owner_becomes_a_neutral_node_with_owns_edges() {
        let mut s = Store::default();
        s.upsert(owned_secret("web-tls", "Certificate", "cert-manager.io/v1", "web"));
        s.upsert(owned_secret("web-tls-next", "Certificate", "cert-manager.io/v1", "web"));
        let g = build(&s, &BuildOptions::default());
        let id = "Custom/cert-manager.io/v1/Certificate/s/web";
        let cr: Vec<_> = g.nodes.iter().filter(|n| n.kind == Kind::Custom).collect();
        assert_eq!(cr.len(), 1, "deduplicated: {cr:?}");
        assert_eq!((cr[0].id.as_str(), cr[0].name.as_str(), cr[0].status), (id, "web", Status::Unknown));
        assert_eq!(cr[0].namespace.as_deref(), Some("s"));
        assert!(cr[0].problem.is_none());
        let mut owns: Vec<&str> = g
            .edges
            .iter()
            .filter(|e| e.source == id && e.relation == Relation::Owns)
            .map(|e| e.target.as_str())
            .collect();
        owns.sort();
        assert_eq!(owns, vec!["Secret/s/web-tls", "Secret/s/web-tls-next"]);
    }

    #[test]
    fn built_in_owners_do_not_become_custom_nodes() {
        let mut s = Store::default();
        s.upsert(owned_secret("token", "ServiceAccount", "v1", "missing-sa"));
        let g = build(&s, &BuildOptions::default());
        assert!(g.nodes.iter().all(|n| n.kind != Kind::Custom), "{:?}", g.nodes);
    }

    #[test]
    fn malformed_custom_owner_references_are_skipped() {
        let mut s = Store::default();
        s.upsert(owned_secret("a", "Cert/ificate", "cert-manager.io/v1", "web"));
        s.upsert(owned_secret("b", "Certificate", "cert-manager.io/v1", ""));
        s.upsert(owned_secret("c", "Certificate", "cert-manager.io/v1", "we/b"));
        s.upsert(owned_secret("d", "Certificate", "Bad Group/v1", "web"));
        let g = build(&s, &BuildOptions::default());
        assert!(g.nodes.iter().all(|n| n.kind != Kind::Custom), "{:?}", g.nodes);
        assert!(g.edges.iter().all(|e| !e.source.starts_with("Custom/")));
        assert_eq!(g.nodes.len(), 4);
    }

    #[test]
    fn pods_owned_by_a_custom_resource_are_not_grouped() {
        let mut s = Store::default();
        for i in 0..4 {
            s.upsert(obj(serde_json::json!({
                "apiVersion": "v1", "kind": "Pod",
                "metadata": { "name": format!("wf-{i}"), "namespace": "s", "ownerReferences": [
                    { "apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow", "name": "wf", "uid": "u" }
                ] },
                "spec": { "containers": [{ "name": "main", "image": "busybox" }] }
            })));
        }
        let opts = BuildOptions {
            group_threshold: 1,
            ..BuildOptions::default()
        };
        let g = build(&s, &opts);
        assert!(
            g.nodes.iter().all(|n| n.kind != Kind::PodGroup),
            "a PodGroup id cannot name a custom owner"
        );
        assert_eq!(
            g.edges
                .iter()
                .filter(|e| e.source == "Custom/argoproj.io/v1alpha1/Workflow/s/wf")
                .count(),
            4
        );
    }
}
