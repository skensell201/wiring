//! End-to-end: apply a fixture namespace, run a headless Session, assert the graph.
//! Run: WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored --nocapture

use std::collections::HashSet;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;
use wiring_lib::graph::{Graph, GraphDelta, Relation};
use wiring_lib::kubeconfig;
use wiring_lib::session::emitter::{ChannelEmitter, ConnectionState, OutEvent};
use wiring_lib::session::Session;

const NAMESPACE: &str = "wiring-smoke";

fn kubectl(context: &str, args: &[&str]) {
    let status = Command::new("kubectl")
        .arg("--context")
        .arg(context)
        .args(args)
        .status()
        .expect("kubectl on PATH");
    assert!(status.success(), "kubectl {args:?} failed");
}

/// Apply a delta the way the frontend does, keeping a local copy of the live graph.
fn apply_delta(graph: &mut Graph, delta: GraphDelta) {
    graph.nodes.retain(|n| !delta.removed_nodes.contains(&n.id));
    for updated in delta.updated_nodes {
        match graph.nodes.iter_mut().find(|n| n.id == updated.id) {
            Some(n) => *n = updated,
            None => graph.nodes.push(updated),
        }
    }
    graph.nodes.extend(delta.added_nodes);
    graph.edges.retain(|e| !delta.removed_edges.contains(&e.id));
    graph.edges.extend(delta.added_edges);
    graph.normalize();
}

/// Feed snapshots and deltas into `graph` until `ok(graph)` holds or `deadline` passes.
/// Returns the last graph either way; the caller prints it on failure.
async fn graph_until(
    rx: &mut UnboundedReceiver<OutEvent>,
    graph: &mut Graph,
    deadline: tokio::time::Instant,
    ok: impl Fn(&Graph) -> bool,
) -> bool {
    loop {
        if ok(graph) {
            return true;
        }
        let Ok(ev) = tokio::time::timeout_at(deadline, rx.recv()).await else {
            return false;
        };
        match ev.expect("emitter open") {
            OutEvent::GraphSnapshot(g) => *graph = g,
            OutEvent::GraphDelta(d) => apply_delta(graph, d),
            OutEvent::ConnectionError(e) => panic!("connection error: {e:?}"),
            OutEvent::ConnectionState(ConnectionState::Disconnected) => panic!("session disconnected"),
            _ => {}
        }
    }
}

fn fixture_is_live(g: &Graph) -> bool {
    let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    ids.contains(&"Deployment/wiring-smoke/web")
        && ids.contains(&"Service/wiring-smoke/web")
        && ids.contains(&"ConfigMap/wiring-smoke/web-cfg")
        // Owner edges pass through the hidden ReplicaSet.
        && g.edges.iter().filter(|e| e.id.starts_with("Deployment/wiring-smoke/web->Pod/wiring-smoke/")).count() == 2
        && g.edges
            .iter()
            .any(|e| e.source == "ConfigMap/wiring-smoke/web-cfg" && e.relation == Relation::EnvFrom)
}

fn pod_count(g: &Graph) -> usize {
    g.nodes.iter().filter(|n| n.id.starts_with("Pod/wiring-smoke/")).count()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn graph_snapshot_reflects_applied_fixture() {
    let context = std::env::var("WIRING_SMOKE_CONTEXT").expect("set WIRING_SMOKE_CONTEXT");
    let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/smoke.yaml");
    // Idempotent re-runs: a namespace left over from an aborted run is still terminating.
    kubectl(&context, &["delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=true"]);
    kubectl(&context, &["apply", "-f", fixture]);
    kubectl(
        &context,
        &["-n", NAMESPACE, "rollout", "status", "deployment/web", "--timeout=180s"],
    );

    let merged = kubeconfig::load_merged(&kubeconfig::default_paths()).unwrap();
    let (emitter, mut rx) = ChannelEmitter::new();
    let (mut session, info) = Session::connect(merged, &context, Arc::new(emitter)).await.unwrap();
    assert!(info.namespaces.contains(&NAMESPACE.to_string()));
    session.select_namespace(NAMESPACE, HashSet::new()).await.unwrap();

    // The reducer announces `connected` first; a `disconnected` here would mean a torn-down
    // session leaked its final state into the new one.
    let first = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("an event after select_namespace")
        .expect("emitter open");
    assert_ne!(first, OutEvent::ConnectionState(ConnectionState::Disconnected));
    assert_eq!(first, OutEvent::ConnectionState(ConnectionState::Connected));

    let mut graph = Graph::default();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let ok = graph_until(&mut rx, &mut graph, deadline, fixture_is_live).await;
    assert!(ok, "fixture never fully appeared in the graph; last graph: {graph:#?}");

    // Details for the deployment must render YAML + summary.
    let details = session.get_object("Deployment/wiring-smoke/web").unwrap();
    assert!(details.yaml.contains("kind: Deployment"));
    assert!(details.summary.iter().any(|(k, _)| k == "Replicas"));

    // Scale down and expect deltas to remove a pod.
    kubectl(&context, &["-n", NAMESPACE, "scale", "deployment/web", "--replicas=1"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let ok = graph_until(&mut rx, &mut graph, deadline, |g| pod_count(g) == 1).await;
    assert!(ok, "scale-down never reached the graph; last graph: {graph:#?}");

    session.shutdown();
    kubectl(&context, &["delete", "namespace", NAMESPACE, "--wait=false"]);
}
