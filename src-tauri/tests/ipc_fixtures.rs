//! Guards the IPC contract: every payload type serializes exactly like the committed
//! JSON fixtures that the TypeScript types in src/shared/ipc mirror.

use std::path::PathBuf;

use serde::Serialize;
use wiring_lib::error::{AppError, ErrorKind};
use wiring_lib::graph::{Edge, Graph, GraphDelta, GroupInfo, Node, Relation, Status};
use wiring_lib::kubeconfig::ContextInfo;
use wiring_lib::session::emitter::{ConnectionState, K8sEvent, ObjectEvents};
use wiring_lib::session::{ConnectInfo, ObjectDetails};
use wiring_lib::store::Kind;

fn fixture(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/shared/ipc/fixtures")
        .join(format!("{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn assert_matches<T: Serialize>(name: &str, value: &T) {
    let actual = serde_json::to_value(value).unwrap();
    let expected = fixture(name);
    assert_eq!(actual, expected, "fixture {name}.json drifted from the Rust type");
}

fn node(id: &str, kind: Kind, name: &str, status: Status, badges: &[&str], group: Option<GroupInfo>) -> Node {
    Node {
        id: id.into(),
        kind,
        namespace: Some("payments".into()),
        name: name.into(),
        status,
        badges: badges.iter().map(|s| s.to_string()).collect(),
        group,
    }
}

#[test]
fn context_info() {
    assert_matches(
        "context_info",
        &ContextInfo {
            name: "prod-eu".into(),
            cluster: "prod-eu-cluster".into(),
            user: "alice".into(),
            namespace: Some("payments".into()),
            source_file: "/Users/alice/.kube/config".into(),
        },
    );
}

#[test]
fn connect_info() {
    assert_matches(
        "connect_info",
        &ConnectInfo {
            context: "prod-eu".into(),
            server_version: "v1.33.2".into(),
            namespaces: vec!["default".into(), "kube-system".into(), "payments".into()],
        },
    );
}

#[test]
fn graph() {
    let g = Graph {
        nodes: vec![
            node(
                "Deployment/payments/web",
                Kind::Deployment,
                "web",
                Status::Ok,
                &["3/3", "nginx:1.27"],
                None,
            ),
            node(
                "PodGroup/payments/Deployment/web",
                Kind::PodGroup,
                "web",
                Status::Err,
                &["×7", "6 ok · 1 err"],
                Some(GroupInfo {
                    count: 7,
                    ok: 6,
                    warn: 0,
                    err: 1,
                }),
            ),
        ],
        edges: vec![Edge::new(
            "Deployment/payments/web",
            "PodGroup/payments/Deployment/web",
            Relation::Owns,
        )],
    };
    assert_matches("graph", &g);
}

#[test]
fn graph_delta() {
    let d = GraphDelta {
        added_nodes: vec![node("Pod/payments/web-1", Kind::Pod, "web-1", Status::Warn, &["Pending"], None)],
        updated_nodes: vec![],
        removed_nodes: vec!["Pod/payments/web-0".into()],
        added_edges: vec![Edge::new("ServiceAccount/payments/default", "Pod/payments/web-1", Relation::UsesSa)],
        removed_edges: vec!["ServiceAccount/payments/default->Pod/payments/web-0:usesSA".into()],
    };
    assert_matches("graph_delta", &d);
}

#[test]
fn object_details() {
    assert_matches(
        "object_details",
        &ObjectDetails {
            yaml: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n".into(),
            summary: vec![("Name".into(), "cfg".into()), ("Kind".into(), "ConfigMap".into())],
            related: vec!["Pod/payments/web-1".into()],
        },
    );
}

#[test]
fn object_events() {
    assert_matches(
        "object_events",
        &ObjectEvents {
            node_id: "Pod/payments/web-1".into(),
            events: vec![K8sEvent {
                name: "web-1.17f2a".into(),
                type_: "Warning".into(),
                reason: "BackOff".into(),
                message: "Back-off restarting failed container".into(),
                count: 14,
                first_timestamp: Some("2026-09-17T10:00:00Z".into()),
                last_timestamp: Some("2026-09-17T10:20:00Z".into()),
            }],
        },
    );
}

#[test]
fn connection_state_and_error() {
    assert_matches("connection_state", &ConnectionState::Degraded);
    assert_matches("app_error", &AppError::new(ErrorKind::Forbidden, "secrets is forbidden"));
}
