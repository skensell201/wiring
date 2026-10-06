//! The graph types shipped to the frontend: `Node`/`Edge`/`Graph`/`GraphDelta`, plus the
//! `Status`/`Relation` enums and `GroupInfo` used by PodGroup nodes. Pure data — no
//! Kubernetes types leak in here; `graph::build` and `graph::status` do that translation.

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

/// Why a node is yellow or red. `cause` names the neighbour to blame (a workload's failing pod,
/// a Service's unready pods); the frontend follows it to the root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Problem {
    pub reason: String,
    pub message: Option<String>,
    pub cause: Option<NodeId>,
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
    /// Set only when `status` is Warn or Err.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<Problem>,
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
    #[serde(rename = "applies")]
    Applies,
    #[serde(rename = "allows")]
    Allows,
    #[serde(rename = "grants")]
    Grants,
    #[serde(rename = "subject")]
    Subject,
    #[serde(rename = "runsOn")]
    RunsOn,
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
            Relation::Applies => "applies",
            Relation::Allows => "allows",
            Relation::Grants => "grants",
            Relation::Subject => "subject",
            Relation::RunsOn => "runsOn",
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
        Edge {
            id: format!("{source}->{target}:{}", relation.as_str()),
            source,
            target,
            relation,
        }
    }
}

/// Above this many nodes the graph is not sent; the frontend shows tables instead.
pub const MAX_GRAPH_NODES: usize = 1500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindStat {
    pub kind: Kind,
    pub count: usize,
    pub worst: Status,
}

/// Sent instead of the nodes of a graph with more than `MAX_GRAPH_NODES` nodes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TooLarge {
    pub nodes: usize,
    pub kinds: Vec<KindStat>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    #[serde(rename = "tooLarge", default, skip_serializing_if = "Option::is_none")]
    pub too_large: Option<TooLarge>,
}

impl Graph {
    /// What crosses IPC instead of `full` when it is too large: no nodes or edges, only the node
    /// count and per-kind totals (a PodGroup counts its pods as Pods) for the navigator.
    pub fn summarised(full: &Graph) -> Graph {
        let mut by_kind: std::collections::BTreeMap<Kind, (usize, Status)> = std::collections::BTreeMap::new();
        for n in &full.nodes {
            let (kind, count) = match (n.kind, &n.group) {
                (Kind::PodGroup, group) => (Kind::Pod, group.as_ref().map_or(0, |g| g.count)),
                (kind, _) => (kind, 1),
            };
            let entry = by_kind.entry(kind).or_insert((0, Status::Unknown));
            entry.0 += count;
            entry.1 = entry.1.max(n.status);
        }
        Graph {
            nodes: vec![],
            edges: vec![],
            too_large: Some(TooLarge {
                nodes: full.nodes.len(),
                kinds: by_kind
                    .into_iter()
                    .map(|(kind, (count, worst))| KindStat { kind, count, worst })
                    .collect(),
            }),
        }
    }

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
    fn a_summarised_graph_keeps_only_counts() {
        let mut full = Graph::default();
        for i in 0..3 {
            full.nodes.push(Node {
                id: format!("ConfigMap/n/c{i}"),
                kind: Kind::ConfigMap,
                namespace: Some("n".into()),
                name: format!("c{i}"),
                status: if i == 0 { Status::Warn } else { Status::Ok },
                badges: vec![],
                group: None,
                problem: None,
            });
        }
        full.nodes.push(Node {
            id: "PodGroup/n/Deployment/web".into(),
            kind: Kind::PodGroup,
            namespace: Some("n".into()),
            name: "web".into(),
            status: Status::Ok,
            badges: vec![],
            group: Some(GroupInfo {
                count: 7,
                ok: 7,
                warn: 0,
                err: 0,
            }),
            problem: None,
        });
        let s = Graph::summarised(&full);
        assert!(s.nodes.is_empty() && s.edges.is_empty());
        let t = s.too_large.clone().unwrap();
        assert_eq!(t.nodes, 4);
        assert_eq!(
            t.kinds,
            vec![
                KindStat {
                    kind: Kind::Pod,
                    count: 7,
                    worst: Status::Ok
                },
                KindStat {
                    kind: Kind::ConfigMap,
                    count: 3,
                    worst: Status::Warn
                },
            ]
        );
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["tooLarge"]["nodes"], 4);
        assert!(serde_json::to_value(Graph::default()).unwrap().get("tooLarge").is_none());
    }

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
            problem: None,
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

    fn test_node(id: &str) -> Node {
        Node {
            id: id.into(),
            kind: Kind::Pod,
            namespace: Some("p".into()),
            name: id.into(),
            status: Status::Ok,
            badges: vec![],
            group: None,
            problem: None,
        }
    }

    #[test]
    fn normalize_sorts_and_dedups_edges() {
        let (a_node, b_node, c_node) = (test_node("a"), test_node("b"), test_node("c"));
        let e_ab = Edge::new("a", "b", Relation::Owns);
        let e_bc = Edge::new("b", "c", Relation::Selects);

        let mut a = Graph {
            nodes: vec![c_node.clone(), a_node.clone(), b_node.clone()],
            edges: vec![e_bc.clone(), e_ab.clone()],
            too_large: None,
        };
        let mut b = Graph {
            nodes: vec![b_node, c_node, a_node],
            edges: vec![e_ab.clone(), e_bc, e_ab],
            too_large: None,
        };

        a.normalize();
        b.normalize();

        assert_eq!(a, b);
        assert_eq!(a.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
        assert_eq!(a.edges.len(), 2);
    }

    #[test]
    fn problem_is_omitted_when_absent_and_camel_case_when_present() {
        let mut n = test_node("Pod/p/a");
        let json = serde_json::to_value(&n).unwrap();
        assert!(json.get("problem").is_none(), "a healthy node carries no problem key: {json}");

        n.problem = Some(Problem {
            reason: "ImagePullBackOff".into(),
            message: Some("container web: Back-off pulling image".into()),
            cause: None,
        });
        let json = serde_json::to_value(&n).unwrap();
        assert_eq!(
            json["problem"],
            serde_json::json!({ "reason": "ImagePullBackOff", "message": "container web: Back-off pulling image", "cause": null })
        );
        let back: Node = serde_json::from_value(json).unwrap();
        assert_eq!(back, n);
    }
}
