//! End-to-end: apply a fixture namespace, run a headless Session, assert the graph.
//! Run: WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored --nocapture

use std::collections::HashSet;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use wiring_lib::kubeconfig;
use wiring_lib::session::emitter::{ChannelEmitter, OutEvent};
use wiring_lib::session::Session;

fn kubectl(context: &str, args: &[&str]) {
    let status = Command::new("kubectl")
        .arg("--context")
        .arg(context)
        .args(args)
        .status()
        .expect("kubectl on PATH");
    assert!(status.success(), "kubectl {args:?} failed");
}

#[tokio::test]
#[ignore]
async fn graph_snapshot_reflects_applied_fixture() {
    let context = std::env::var("WIRING_SMOKE_CONTEXT").expect("set WIRING_SMOKE_CONTEXT");
    let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/smoke.yaml");
    kubectl(&context, &["apply", "-f", fixture]);

    let merged = kubeconfig::load_merged(&kubeconfig::default_paths()).unwrap();
    let (emitter, mut rx) = ChannelEmitter::new();
    let (mut session, info) = Session::connect(merged, &context, Arc::new(emitter)).await.unwrap();
    assert!(info.namespaces.contains(&"wiring-smoke".to_string()));
    session.select_namespace("wiring-smoke", HashSet::new()).await.unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let graph = loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("snapshot before deadline")
            .expect("emitter open");
        match ev {
            OutEvent::GraphSnapshot(g) => break g,
            OutEvent::ConnectionError(e) => panic!("connection error: {e:?}"),
            _ => continue,
        }
    };

    let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    assert!(ids.contains(&"Deployment/wiring-smoke/web"), "{ids:?}");
    assert!(ids.contains(&"Service/wiring-smoke/web"), "{ids:?}");
    assert!(ids.contains(&"ConfigMap/wiring-smoke/web-cfg"), "{ids:?}");
    assert!(
        graph
            .edges
            .iter()
            .any(|e| e.id.starts_with("Deployment/wiring-smoke/web->Pod/wiring-smoke/")),
        "owner edges pass through hidden RS"
    );
    assert!(graph
        .edges
        .iter()
        .any(|e| e.source == "ConfigMap/wiring-smoke/web-cfg" && e.relation == wiring_lib::graph::Relation::EnvFrom));

    // Details for the deployment must render YAML + summary.
    let details = session.get_object("Deployment/wiring-smoke/web").unwrap();
    assert!(details.yaml.contains("kind: Deployment"));
    assert!(details.summary.iter().any(|(k, _)| k == "Replicas"));

    // Scale down and expect a delta removing a pod within the debounce window.
    kubectl(&context, &["-n", "wiring-smoke", "scale", "deployment/web", "--replicas=1"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("delta before deadline")
            .expect("emitter open");
        if let OutEvent::GraphDelta(d) = ev {
            if d.removed_nodes.iter().any(|id| id.starts_with("Pod/wiring-smoke/")) {
                break;
            }
        }
    }

    session.shutdown();
    kubectl(&context, &["delete", "namespace", "wiring-smoke", "--wait=false"]);
}
