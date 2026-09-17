//! Store -> Graph. Pure and deterministic.

use std::collections::{BTreeMap, HashMap, HashSet};

use super::model::{node_id, Edge, Graph, GroupInfo, Node, NodeId, Relation, Status};
use super::relations::all_edges;
use super::status::describe;
use crate::store::{Kind, Object, Store};

#[derive(Debug, Clone)]
pub struct BuildOptions {
    pub expanded_groups: HashSet<NodeId>,
    /// Collapse pods of one owner when there are more than this many.
    pub group_threshold: usize,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self { expanded_groups: HashSet::new(), group_threshold: 5 }
    }
}

pub fn build(store: &Store, opts: &BuildOptions) -> Graph {
    let mut nodes: HashMap<NodeId, Node> = HashMap::new();
    for obj in store.iter() {
        if is_stale_replicaset(obj) {
            continue;
        }
        let (status, badges) = describe(obj, store);
        let id = node_id(obj.kind(), obj.namespace(), obj.name());
        nodes.insert(
            id.clone(),
            Node { id, kind: obj.kind(), namespace: obj.namespace().map(str::to_owned), name: obj.name().to_owned(), status, badges, group: None },
        );
    }

    let mut edges: Vec<Edge> = all_edges(store)
        .into_iter()
        .filter(|e| nodes.contains_key(&e.source) && nodes.contains_key(&e.target))
        .collect();

    hide_single_replicasets(&mut nodes, &mut edges);
    collapse_pod_groups(&mut nodes, &mut edges, opts);

    let mut graph = Graph { nodes: nodes.into_values().collect(), edges };
    graph.normalize();
    graph
}

/// Old revisions: desired 0 and current 0.
fn is_stale_replicaset(obj: &Object) -> bool {
    let Object::ReplicaSet(rs) = obj else { return false };
    let desired = rs.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let current = rs.status.as_ref().map(|s| s.replicas).unwrap_or(0);
    desired == 0 && current == 0
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
            .map(|e| if e.source == *rs { Edge::new(dep.clone(), e.target, e.relation) } else { e })
            .collect();
    }
}

/// Collapse pods with the same immediate owner into a PodGroup node.
fn collapse_pod_groups(nodes: &mut HashMap<NodeId, Node>, edges: &mut Vec<Edge>, opts: &BuildOptions) {
    // owner id -> member pod ids
    let mut members: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
    for e in edges.iter() {
        if e.relation == Relation::Owns && nodes.get(&e.target).map(|n| n.kind) == Some(Kind::Pod) {
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
        let group_id = format!("PodGroup/{}/{}/{}", owner_ns.as_deref().unwrap_or(""), owner_kind.as_str(), owner_name);
        if opts.expanded_groups.contains(&group_id) {
            continue;
        }
        let mut info = GroupInfo { count: pods.len(), ok: 0, warn: 0, err: 0 };
        let mut worst = Status::Unknown;
        for pod_id in &pods {
            let pod = nodes.remove(pod_id).expect("member pod exists");
            match pod.status {
                Status::Ok => info.ok += 1,
                Status::Warn => info.warn += 1,
                Status::Err => info.err += 1,
                Status::Unknown => {}
            }
            worst = worst.max(pod.status);
            remap.insert(pod_id.clone(), group_id.clone());
        }
        let mut counts = vec![];
        if info.ok > 0 { counts.push(format!("{} ok", info.ok)); }
        if info.warn > 0 { counts.push(format!("{} warn", info.warn)); }
        if info.err > 0 { counts.push(format!("{} err", info.err)); }
        nodes.insert(
            group_id.clone(),
            Node {
                id: group_id.clone(),
                kind: Kind::PodGroup,
                namespace: owner_ns,
                name: owner_name,
                status: worst,
                badges: vec![format!("×{}", info.count), counts.join(" · ")],
                group: Some(info),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::Status;
    use crate::store::{Kind, Store};

    fn edge_ids(g: &Graph) -> Vec<&str> {
        g.edges.iter().map(|e| e.id.as_str()).collect()
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
        assert_eq!(group.group, Some(GroupInfo { count: 7, ok: 6, warn: 0, err: 1 }));
        assert_eq!(group.badges, vec!["×7", "6 ok · 1 err"]);
        assert_eq!(
            edge_ids(&g),
            vec![
                "ConfigMap/g/api-cfg->PodGroup/g/Deployment/api:envFrom",
                "Deployment/g/api->PodGroup/g/Deployment/api:owns",
                "Service/g/api->PodGroup/g/Deployment/api:selects",
            ]
        );
    }

    #[test]
    fn expanded_group_shows_individual_pods() {
        let s = Store::from_fixture("podgroup").unwrap();
        let opts = BuildOptions { expanded_groups: ["PodGroup/g/Deployment/api".to_string()].into_iter().collect(), ..Default::default() };
        let g = build(&s, &opts);
        assert!(g.node("PodGroup/g/Deployment/api").is_none());
        assert_eq!(g.nodes.iter().filter(|n| n.kind == Kind::Pod).count(), 7);
        assert!(g.edges.iter().any(|e| e.id == "Deployment/g/api->Pod/g/api-new-7:owns"));
    }

    #[test]
    fn threshold_is_strictly_greater_than() {
        let s = Store::from_fixture("podgroup").unwrap();
        let opts = BuildOptions { group_threshold: 7, ..Default::default() };
        let g = build(&s, &opts);
        assert!(g.node("PodGroup/g/Deployment/api").is_none(), "7 pods with threshold 7 stay expanded");
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
}
