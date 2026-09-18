//! End-to-end: apply a fixture namespace, run a headless Session, assert the graph, then
//! exercise the write path (update / conflict / create / delete / PodGroup delete).
//! Run: WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored --nocapture

use std::collections::HashSet;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;
use wiring_lib::error::ErrorKind;
use wiring_lib::graph::{Graph, GraphDelta, Relation};
use wiring_lib::kubeconfig;
use wiring_lib::session::emitter::{ChannelEmitter, ConnectionState, OutEvent};
use wiring_lib::session::Session;
use wiring_lib::store::Kind;

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
            // Fatal per-kind failures mean the cluster/RBAC is not what the test needs;
            // transient errors (watch resets) are logged and the loop keeps waiting.
            OutEvent::ConnectionError(e) if matches!(e.kind, ErrorKind::Forbidden | ErrorKind::Auth | ErrorKind::NotFound) => {
                panic!("connection error: {e:?}")
            }
            OutEvent::ConnectionError(e) => eprintln!("transient watcher error: {e:?}"),
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

fn has_node(g: &Graph, id: &str) -> bool {
    g.node(id).is_some()
}

const CONFIGMAP_ID: &str = "ConfigMap/wiring-smoke/web-cfg";
const CREATED_ID: &str = "ConfigMap/wiring-smoke/smoke-created";
const GROUP_ID: &str = "PodGroup/wiring-smoke/Deployment/web";

/// Names of the pods currently in the store (the graph may have collapsed them).
fn pod_names(session: &Session) -> Vec<String> {
    session
        .list_rows(Kind::Pod)
        .rows
        .into_iter()
        .map(|r| r.node_id.trim_start_matches("Pod/wiring-smoke/").to_owned())
        .collect()
}

/// Update / conflict / create / delete / invalid on ConfigMaps, then delete a PodGroup.
async fn exercise_writes(session: &Session, rx: &mut UnboundedReceiver<OutEvent>, graph: &mut Graph, context: &str) {
    // (1) Add a key; the returned details are fresh even before the watch echo.
    let old_yaml = session.get_object(CONFIGMAP_ID).unwrap().yaml;
    assert!(old_yaml.contains("  GREETING: hello\n"), "{old_yaml}");
    let new_yaml = old_yaml.replace("  GREETING: hello\n", "  GREETING: hello\n  SMOKE_KEY: added\n");
    let details = session.update_object(CONFIGMAP_ID, &new_yaml, false).await.unwrap();
    assert!(details.yaml.contains("SMOKE_KEY: added"), "{}", details.yaml);
    // The graph must pick the edit up from the save itself: the watch echo carries the same
    // resourceVersion and is ignored by the reducer as unchanged.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let ok = graph_until(rx, graph, deadline, |g| {
        g.node(CONFIGMAP_ID).is_some_and(|n| n.badges.iter().any(|b| b == "2 keys"))
    })
    .await;
    assert!(ok, "ConfigMap badge never showed 2 keys; last graph: {graph:#?}");
    // A manifest without resourceVersion cannot be saved unconditionally.
    let no_rv: String = new_yaml
        .lines()
        .filter(|l| !l.contains("resourceVersion"))
        .map(|l| format!("{l}\n"))
        .collect();
    let err = session.update_object(CONFIGMAP_ID, &no_rv, false).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
    assert!(err.message.contains("resourceVersion"), "{}", err.message);

    // (2) The old YAML carries a stale resourceVersion: conflict, unless forced.
    let err = session.update_object(CONFIGMAP_ID, &old_yaml, false).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Conflict, "{err:?}");
    eprintln!("conflict: {}", err.message);
    let details = session.update_object(CONFIGMAP_ID, &old_yaml, true).await.unwrap();
    assert!(!details.yaml.contains("SMOKE_KEY"), "{}", details.yaml);

    // (3) Create from a manifest without a namespace: the selected one is used.
    let created = session
        .create_object(
            NAMESPACE,
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: smoke-created\ndata:\n  A: b\n",
        )
        .await
        .unwrap();
    assert_eq!(created, CREATED_ID);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let ok = graph_until(rx, graph, deadline, |g| has_node(g, CREATED_ID)).await;
    assert!(ok, "created ConfigMap never reached the graph; last graph: {graph:#?}");
    let err = session
        .create_object(NAMESPACE, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: smoke-created\n")
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Conflict, "creating twice is a conflict: {err:?}");

    // (4) Delete it; deleting again is not an error.
    session.delete_object(CREATED_ID).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let ok = graph_until(rx, graph, deadline, |g| !has_node(g, CREATED_ID)).await;
    assert!(ok, "deleted ConfigMap still in the graph; last graph: {graph:#?}");
    session.delete_object(CREATED_ID).await.unwrap();

    // (5) Type errors and unknown fields (fieldValidation=Strict) are `invalid`.
    let current = session.get_object(CONFIGMAP_ID).unwrap().yaml;
    // `data:` sits on its own line (the tail of `metadata:` must not match).
    let bad_type = current.replace("data:\n  GREETING: hello\n", "data: 1\n");
    assert_ne!(bad_type, current, "{current}");
    let err = session.update_object(CONFIGMAP_ID, &bad_type, false).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
    eprintln!("invalid (type): {}", err.message);
    let unknown_field = format!("{current}bogusField: 1\n");
    let err = session.update_object(CONFIGMAP_ID, &unknown_field, false).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
    assert!(err.message.contains("bogusField"), "{}", err.message);
    eprintln!("invalid (strict): {}", err.message);
    let err = session
        .update_object("ConfigMap/wiring-smoke/other", &current, false)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid, "renaming through update is refused: {err:?}");

    // (6) Scale up so the pods collapse into a group, delete the group, expect fresh pods.
    kubectl(context, &["-n", NAMESPACE, "scale", "deployment/web", "--replicas=6"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let ok = graph_until(rx, graph, deadline, |g| {
        g.node(GROUP_ID).and_then(|n| n.group.as_ref()).is_some_and(|i| i.count == 6)
    })
    .await;
    assert!(ok, "PodGroup with 6 pods never appeared; last graph: {graph:#?}");
    let before = pod_names(session);
    assert_eq!(before.len(), 6, "{before:?}");
    session.delete_object(GROUP_ID).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let ok = graph_until(rx, graph, deadline, |_| {
        let now = pod_names(session);
        now.len() == 6 && now.iter().all(|n| !before.contains(n))
    })
    .await;
    assert!(
        ok,
        "pods were not recreated after the group delete; before: {before:?}, now: {:?}",
        pod_names(session)
    );
    eprintln!("group delete: {before:?} -> {:?}", pod_names(session));
    let err = session.delete_object("PodGroup/wiring-smoke/Deployment/nope").await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound, "{err:?}");
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

    exercise_writes(&session, &mut rx, &mut graph, &context).await;

    session.shutdown();
    kubectl(&context, &["delete", "namespace", NAMESPACE, "--wait=false"]);
}
