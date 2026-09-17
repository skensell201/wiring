use serde::{Deserialize, Serialize};

use crate::store::Kind;

pub type NodeId = String;

/// Ordered so that `max()` yields the worst status: Unknown < Ok < Warn < Err.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Unknown,
    Ok,
    Warn,
    Err,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupInfo {
    pub count: usize,
    pub ok: usize,
    pub warn: usize,
    pub err: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: NodeId,
    pub kind: Kind,
    pub namespace: Option<String>,
    pub name: String,
    pub status: Status,
    pub badges: Vec<String>,
    pub group: Option<GroupInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Relation {
    #[serde(rename = "owns")]
    Owns,
    #[serde(rename = "selects")]
    Selects,
    #[serde(rename = "routes")]
    Routes,
    #[serde(rename = "mounts")]
    Mounts,
    #[serde(rename = "envFrom")]
    EnvFrom,
    #[serde(rename = "claims")]
    Claims,
    #[serde(rename = "binds")]
    Binds,
    #[serde(rename = "usesSA")]
    UsesSa,
    #[serde(rename = "scales")]
    Scales,
}

impl Relation {
    pub fn as_str(self) -> &'static str {
        match self {
            Relation::Owns => "owns",
            Relation::Selects => "selects",
            Relation::Routes => "routes",
            Relation::Mounts => "mounts",
            Relation::EnvFrom => "envFrom",
            Relation::Claims => "claims",
            Relation::Binds => "binds",
            Relation::UsesSa => "usesSA",
            Relation::Scales => "scales",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub source: NodeId,
    pub target: NodeId,
    pub relation: Relation,
}

impl Edge {
    pub fn new(source: impl Into<NodeId>, target: impl Into<NodeId>, relation: Relation) -> Edge {
        let source = source.into();
        let target = target.into();
        Edge { id: format!("{source}->{target}:{}", relation.as_str()), source, target, relation }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

impl Graph {
    /// Sort nodes and edges by id and drop duplicate edges, so equal graphs compare equal.
    pub fn normalize(&mut self) {
        self.nodes.sort_by(|a, b| a.id.cmp(&b.id));
        self.edges.sort_by(|a, b| a.id.cmp(&b.id));
        self.edges.dedup_by(|a, b| a.id == b.id);
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn edges_touching<'a>(&'a self, id: &'a str) -> impl Iterator<Item = &'a Edge> + 'a {
        self.edges.iter().filter(move |e| e.source == id || e.target == id)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDelta {
    pub added_nodes: Vec<Node>,
    pub updated_nodes: Vec<Node>,
    pub removed_nodes: Vec<NodeId>,
    pub added_edges: Vec<Edge>,
    pub removed_edges: Vec<String>,
}

impl GraphDelta {
    pub fn is_empty(&self) -> bool {
        self.added_nodes.is_empty()
            && self.updated_nodes.is_empty()
            && self.removed_nodes.is_empty()
            && self.added_edges.is_empty()
            && self.removed_edges.is_empty()
    }
}

pub fn node_id(kind: Kind, namespace: Option<&str>, name: &str) -> NodeId {
    format!("{}/{}/{}", kind.as_str(), namespace.unwrap_or(""), name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Kind;

    #[test]
    fn node_id_formats_namespaced_and_cluster_scoped() {
        assert_eq!(node_id(Kind::Pod, Some("payments"), "web-1"), "Pod/payments/web-1");
        assert_eq!(node_id(Kind::PersistentVolume, None, "pv-1"), "PersistentVolume//pv-1");
    }

    #[test]
    fn edge_id_is_source_target_relation() {
        let e = Edge::new("Service/p/svc", "Pod/p/a", Relation::Selects);
        assert_eq!(e.id, "Service/p/svc->Pod/p/a:selects");
    }

    #[test]
    fn serializes_with_camel_case_and_lowercase_enums() {
        let n = Node {
            id: "Pod/p/a".into(),
            kind: Kind::Pod,
            namespace: Some("p".into()),
            name: "a".into(),
            status: Status::Err,
            badges: vec!["CrashLoopBackOff".into()],
            group: None,
        };
        let json = serde_json::to_value(&n).unwrap();
        assert_eq!(json["status"], "err");
        assert_eq!(json["kind"], "Pod");
        assert!(json["group"].is_null());
        let e = Edge::new("a", "b", Relation::UsesSa);
        assert_eq!(serde_json::to_value(&e).unwrap()["relation"], "usesSA");
    }

    #[test]
    fn status_worst_ordering() {
        assert_eq!(Status::Ok.max(Status::Warn), Status::Warn);
        assert_eq!(Status::Err.max(Status::Unknown), Status::Err);
        assert_eq!(Status::Unknown.max(Status::Ok), Status::Ok);
    }
}
