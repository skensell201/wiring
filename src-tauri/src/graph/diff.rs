//! Compute the minimal change set between two normalized graphs.

use std::collections::HashMap;

use super::model::{Graph, GraphDelta};

pub fn diff(old: &Graph, new: &Graph) -> GraphDelta {
    let old_nodes: HashMap<&str, _> = old.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let new_nodes: HashMap<&str, _> = new.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let old_edges: HashMap<&str, _> = old.edges.iter().map(|e| (e.id.as_str(), e)).collect();
    let new_edges: HashMap<&str, _> = new.edges.iter().map(|e| (e.id.as_str(), e)).collect();

    let mut delta = GraphDelta::default();
    for n in &new.nodes {
        match old_nodes.get(n.id.as_str()) {
            None => delta.added_nodes.push(n.clone()),
            Some(o) if *o != n => delta.updated_nodes.push(n.clone()),
            Some(_) => {}
        }
    }
    for n in &old.nodes {
        if !new_nodes.contains_key(n.id.as_str()) {
            delta.removed_nodes.push(n.id.clone());
        }
    }
    for e in &new.edges {
        if !old_edges.contains_key(e.id.as_str()) {
            delta.added_edges.push(e.clone());
        }
    }
    for e in &old.edges {
        if !new_edges.contains_key(e.id.as_str()) {
            delta.removed_edges.push(e.id.clone());
        }
    }
    delta
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::{Edge, Node, Relation, Status};
    use crate::store::Kind;

    fn node(id: &str, status: Status) -> Node {
        Node { id: id.into(), kind: Kind::Pod, namespace: Some("n".into()), name: id.into(), status, badges: vec![], group: None }
    }

    fn graph(nodes: Vec<Node>, edges: Vec<Edge>) -> Graph {
        let mut g = Graph { nodes, edges };
        g.normalize();
        g
    }

    #[test]
    fn identical_graphs_give_empty_delta() {
        let g = graph(vec![node("a", Status::Ok)], vec![]);
        assert!(diff(&g, &g).is_empty());
    }

    #[test]
    fn detects_added_updated_removed_nodes_and_edges() {
        let old = graph(
            vec![node("a", Status::Ok), node("b", Status::Ok), node("c", Status::Ok)],
            vec![Edge::new("a", "b", Relation::Owns), Edge::new("a", "c", Relation::Owns)],
        );
        let new = graph(
            vec![node("a", Status::Ok), node("b", Status::Err), node("d", Status::Ok)],
            vec![Edge::new("a", "b", Relation::Owns), Edge::new("a", "d", Relation::Owns)],
        );
        let d = diff(&old, &new);
        assert_eq!(d.added_nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec!["d"]);
        assert_eq!(d.updated_nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(d.removed_nodes, vec!["c"]);
        assert_eq!(d.added_edges.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["a->d:owns"]);
        assert_eq!(d.removed_edges, vec!["a->c:owns"]);
    }
}
