//! End-to-end: apply a fixture namespace, run a headless Session, assert the graph, then
//! exercise the write path (update / conflict / create / delete / PodGroup delete), the rollout
//! actions (scale / restart / history / rollback), log streaming (start / lines / stop / invalid kind),
//! and, on docker-desktop only, custom resources (discovery / table / watch / edit / create / delete /
//! CR owner on the graph) and Helm releases (list / details / hidden storage Secret). That phase
//! creates `crd/wiringsmokes.wiringsmoke.example.com`, the only cluster-scoped object the test
//! makes, and always deletes it, also when the run fails; on any other context it is skipped.
//! Run: WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored --nocapture

use std::collections::HashSet;
use std::io::Write as _;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::write::GzEncoder;
use flate2::Compression;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::sync::Mutex;
use wiring_lib::custom::id::CustomId;
use wiring_lib::custom::{ops, CustomTable};
use wiring_lib::discovery;
use wiring_lib::error::ErrorKind;
use wiring_lib::exec::session::ExecRequest;
use wiring_lib::exec::{ExecMessage, ExecPod};
use wiring_lib::forward::resolve::suggest_local_port;
use wiring_lib::graph::{Graph, GraphDelta, Problem, Relation, Status};
use wiring_lib::kubeconfig;
use wiring_lib::logs::session::LogRequest;
use wiring_lib::logs::LogMessage;
use wiring_lib::manifest;
use wiring_lib::session::custom::{list_custom, resolve_kind};
use wiring_lib::session::emitter::{ChannelEmitter, ConnectionState, OutEvent};
use wiring_lib::session::rollout::Revision;
use wiring_lib::session::scope::NamespaceScope;
use wiring_lib::session::Session;
use wiring_lib::store::Kind;

const NAMESPACE: &str = "wiring-smoke";
const NAMESPACE_B: &str = "wiring-smoke-b";

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

/// Pods of the `web` Deployment in the graph; the `talker` pod (log fixture) is not counted.
fn web_pod_count(g: &Graph) -> usize {
    g.nodes.iter().filter(|n| n.id.starts_with("Pod/wiring-smoke/web-")).count()
}

fn has_node(g: &Graph, id: &str) -> bool {
    g.node(id).is_some()
}

/// The problem at the end of `id`'s cause chain (at most 8 hops), as the frontend resolves it.
fn root_problem<'a>(g: &'a Graph, id: &str) -> Option<&'a Problem> {
    let mut problem = g.node(id)?.problem.as_ref()?;
    for _ in 0..8 {
        let Some(next) = problem.cause.as_deref() else { break };
        problem = g.node(next)?.problem.as_ref()?;
    }
    Some(problem)
}

const CONFIGMAP_ID: &str = "ConfigMap/wiring-smoke/web-cfg";
const CREATED_ID: &str = "ConfigMap/wiring-smoke/smoke-created";
const GROUP_ID: &str = "PodGroup/wiring-smoke/Deployment/web";

/// Names of the `web` pods currently in the store (the graph may have collapsed them);
/// the `talker` pod is left out.
fn pod_names(session: &Session) -> Vec<String> {
    session
        .list_rows(Kind::Pod, false)
        .rows
        .into_iter()
        .map(|r| r.node_id.trim_start_matches("Pod/wiring-smoke/").to_owned())
        .filter(|n| n.starts_with("web-"))
        .collect()
}

/// Whether the cluster serves the Metrics API (metrics-server installed).
fn metrics_api_served(context: &str) -> bool {
    Command::new("kubectl")
        .args(["--context", context, "get", "apiservice", "v1beta1.metrics.k8s.io"])
        .output()
        .is_ok_and(|o| o.status.success())
}

/// What the Metrics API itself says about the namespace's pods (for a timeout message).
fn raw_pod_metrics(context: &str) -> String {
    let path = format!("/apis/metrics.k8s.io/v1beta1/namespaces/{NAMESPACE}/pods");
    match Command::new("kubectl").args(["--context", context, "get", "--raw", &path]).output() {
        Ok(o) => format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)),
        Err(e) => format!("kubectl failed: {e}"),
    }
}

/// With metrics-server: the talker pod gets CPU/Memory cells and Overview usage rows. Without it:
/// the cells stay `—` and Overview says the Metrics API is missing. Runs last, so the wait for
/// the first sample overlaps the other phases.
async fn exercise_metrics(session: &Session, context: &str) {
    let served = metrics_api_served(context);
    // metrics-server needs a scrape or two (15 s each) before a new pod shows up; on a busy
    // docker-desktop node it can take a few minutes.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    loop {
        let table = session.list_rows(Kind::Pod, false);
        let cpu = table
            .columns
            .iter()
            .position(|c| c.key == "cpu")
            .expect("the Pod table has a CPU column");
        let mem = table
            .columns
            .iter()
            .position(|c| c.key == "memory")
            .expect("the Pod table has a Memory column");
        let talker = table
            .rows
            .iter()
            .find(|r| r.node_id.starts_with(&format!("Pod/{NAMESPACE}/talker-")))
            .expect("a talker pod row");
        let details = session.get_object(&talker.node_id).unwrap();
        let done = if served {
            talker.cells[cpu].text.ends_with('m')
                && talker.cells[mem].text.ends_with("Mi")
                && details.summary.iter().any(|(k, _)| k == "CPU usage")
                && details.summary.iter().any(|(k, _)| k == "Memory usage")
        } else {
            talker.cells[cpu].text == "—"
                && details
                    .summary
                    .iter()
                    .any(|(k, v)| k == "Usage" && v == "Metrics API not available (install metrics-server)")
        };
        if done {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "metrics never showed up (served: {served}); last cells {:?}, summary {:?}; the Metrics API says: {}",
            talker.cells,
            details.summary,
            raw_pod_metrics(context)
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
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

const WEB_ID: &str = "Deployment/wiring-smoke/web";
const DB_ID: &str = "StatefulSet/wiring-smoke/db";

/// Poll `rollout_history` until `ok` holds or two minutes pass; returns the last answer.
async fn history_until(session: &Session, node_id: &str, ok: impl Fn(&[Revision]) -> bool) -> Vec<Revision> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let revisions = session.rollout_history(node_id).await.unwrap();
        if ok(&revisions) || tokio::time::Instant::now() > deadline {
            return revisions;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Scale, restart and roll back the `web` Deployment and the `db` StatefulSet.
async fn exercise_rollout(session: &Session, rx: &mut UnboundedReceiver<OutEvent>, graph: &mut Graph, context: &str) {
    // (1) Scale through /scale; the returned details already carry the new spec.
    let details = session.scale_object(WEB_ID, 2).await.unwrap();
    assert!(details.yaml.contains("replicas: 2"), "{}", details.yaml);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    let ok = graph_until(rx, graph, deadline, |g| {
        g.node(WEB_ID).is_some_and(|n| n.badges.first().map(String::as_str) == Some("2/2"))
    })
    .await;
    assert!(ok, "web never settled at 2/2; last graph: {graph:#?}");
    for (id, n) in [(WEB_ID, -1), (WEB_ID, 10_001), (CONFIGMAP_ID, 1)] {
        let err = session.scale_object(id, n).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid, "{id} {n}: {err:?}");
    }

    // (2) Restart: a new current revision whose template carries the restartedAt stamp.
    let before = session.rollout_history(WEB_ID).await.unwrap();
    let top = before.iter().map(|r| r.revision).max().expect("web has a revision");
    session.restart_object(WEB_ID).await.unwrap();
    let after = history_until(session, WEB_ID, |r| r.iter().any(|r| r.current && r.revision > top)).await;
    let current = after.iter().find(|r| r.current).unwrap_or_else(|| panic!("{after:#?}"));
    assert!(current.revision > top, "{after:#?}");
    assert!(
        current.template.contains("kubectl.kubernetes.io/restartedAt"),
        "{}",
        current.template
    );
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "deployment/web", "--timeout=180s"]);

    // (3) Roll back to the pre-restart revision: the stamp is gone from the live template.
    let err = session.rollback_object(WEB_ID, current.revision).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
    let err = session.rollback_object(WEB_ID, 999).await.unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound, "{err:?}");
    let details = session.rollback_object(WEB_ID, top).await.unwrap();
    assert!(!details.yaml.contains("restartedAt"), "{}", details.yaml);
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "deployment/web", "--timeout=180s"]);

    // (4) The same through ControllerRevisions for a StatefulSet.
    let before = history_until(session, DB_ID, |r| !r.is_empty()).await;
    assert_eq!(before.len(), 1, "{before:#?}");
    session.restart_object(DB_ID).await.unwrap();
    let after = history_until(session, DB_ID, |r| r.len() == 2 && r[0].current).await;
    assert!(after.len() == 2 && after[0].current, "{after:#?}");
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "statefulset/db", "--timeout=180s"]);
    let details = session.rollback_object(DB_ID, after[1].revision).await.unwrap();
    assert!(!details.yaml.contains("restartedAt"), "{}", details.yaml);
    kubectl(context, &["-n", NAMESPACE, "rollout", "status", "statefulset/db", "--timeout=180s"]);

    // (5) Kinds without a rollout are refused before any request.
    for err in [
        session.restart_object(CONFIGMAP_ID).await.unwrap_err(),
        session.rollout_history(CONFIGMAP_ID).await.unwrap_err(),
        session.rollback_object(GROUP_ID, 1).await.unwrap_err(),
    ] {
        assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
    }
}

const WHOAMI_SVC: &str = "Service/wiring-smoke/whoami";

/// One HTTP/1.0 request through the forward; the whole response.
async fn http_get(port: u16) -> std::io::Result<String> {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    s.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").await?;
    let mut out = String::new();
    tokio::time::timeout(Duration::from_secs(10), s.read_to_string(&mut out))
        .await
        .map_err(|_| std::io::Error::other("timeout"))??;
    Ok(out)
}

/// The pod whoami says served the request.
fn served_by(body: &str) -> Option<String> {
    body.lines().find_map(|l| l.strip_prefix("Hostname: ")).map(str::to_owned)
}

async fn exercise_forward(session: &mut Session, context: &str) {
    kubectl(
        context,
        &["-n", NAMESPACE, "rollout", "status", "deployment/whoami", "--timeout=180s"],
    );
    let ports = session.forward_ports(WHOAMI_SVC).unwrap();
    assert_eq!(ports.iter().map(|p| p.port).collect::<Vec<_>>(), vec![8080], "{ports:?}");
    assert_eq!(
        session.start_forward(CONFIGMAP_ID, 80, 18080).await.unwrap_err().kind,
        ErrorKind::Invalid
    );

    let local = suggest_local_port(18080);
    let fwd = session.start_forward(WHOAMI_SVC, 8080, local).await.unwrap();
    assert_eq!(
        session.start_forward(WHOAMI_SVC, 8080, local).await.unwrap_err().kind,
        ErrorKind::Conflict
    );

    // start returns before the first pod is resolved: poll until a request goes through.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let first = loop {
        if let Some(h) = http_get(local).await.ok().and_then(|b| served_by(&b)) {
            break h;
        }
        assert!(tokio::time::Instant::now() < deadline, "no response through the forward");
        tokio::time::sleep(Duration::from_millis(500)).await;
    };

    // The serving pod goes away: new connections must reach the other one.
    kubectl(context, &["-n", NAMESPACE, "delete", "pod", &first, "--wait=false"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(h) = http_get(local).await.ok().and_then(|b| served_by(&b)) {
            if h != first {
                break;
            }
        }
        assert!(tokio::time::Instant::now() < deadline, "the forward never moved off {first}");
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    session.stop_forward(fwd.id).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::net::TcpStream::connect(("127.0.0.1", local)).await.is_ok() {
        assert!(tokio::time::Instant::now() < deadline, "port {local} still open after stop");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The running pods of `node_id` once the store has them.
async fn exec_pods_until_running(session: &Session, node_id: &str) -> Vec<ExecPod> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        if let Ok(pods) = session.exec_pods(node_id) {
            if !pods.is_empty() {
                return pods;
            }
        }
        assert!(tokio::time::Instant::now() < deadline, "{node_id} never had a running pod");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn exercise_exec(session: &mut Session, context: &str) {
    kubectl(
        context,
        &["-n", NAMESPACE, "rollout", "status", "deployment/talker", "--timeout=180s"],
    );
    let talker = format!("Deployment/{NAMESPACE}/talker");
    let pods = exec_pods_until_running(session, &talker).await;
    assert_eq!(pods[0].containers, vec!["talker".to_string()]);

    let (tx, mut rx) = mpsc::unbounded_channel::<ExecMessage>();
    let req = ExecRequest {
        node_id: talker.clone(),
        pod: pods[0].name.clone(),
        container: "talker".into(),
        cols: 120,
        rows: 30,
    };
    let id = session.start_exec(req, Arc::new(tx)).unwrap();
    // Queued until the shell is up. The TTY echoes the command line, which contains
    // `wiring-$((6*7))`, so only the evaluated `wiring-42` proves the shell ran it.
    session.exec_input(id, b"echo wiring-$((6*7))\n".to_vec());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut out = String::new();
    while !out.contains("wiring-42") {
        match tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("exec output in time")
            .expect("channel open")
        {
            ExecMessage::Output { data, .. } => out.push_str(&String::from_utf8_lossy(&STANDARD.decode(data).unwrap())),
            other => panic!("unexpected {other:?}; output so far: {out}"),
        }
    }
    // A large paste: the TTY echoes every byte back while stdin is still being written, which
    // stalled a serial pump on kube's small pipes. 32 KiB in 64-byte lines (under the line limit).
    session.exec_input(id, b"cat >/dev/null\n".to_vec());
    let line = format!("{}\n", "p".repeat(63));
    for _ in 0..8 {
        session.exec_input(id, line.repeat(64).into_bytes());
    }
    session.exec_input(id, b"\x04echo pasted-$((40+2))\n".to_vec());
    while !out.contains("pasted-42") {
        match tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("the shell answered after the paste in time")
            .expect("channel open")
        {
            ExecMessage::Output { data, .. } => out.push_str(&String::from_utf8_lossy(&STANDARD.decode(data).unwrap())),
            other => panic!("unexpected {other:?} after the paste"),
        }
    }
    session.exec_input(id, b"exit 3\n".to_vec());
    let code = loop {
        match tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("exec end in time")
            .expect("channel open")
        {
            ExecMessage::Output { .. } => continue,
            ExecMessage::Ended { code, .. } => break code,
            ExecMessage::Error { message, .. } => panic!("exec error: {message}"),
        }
    };
    assert_eq!(code, Some(3));
    session.stop_exec(id).await;

    // `db` runs the pause image, which has no shell.
    let db = format!("StatefulSet/{NAMESPACE}/db");
    let pods = exec_pods_until_running(session, &db).await;
    let (tx, mut rx) = mpsc::unbounded_channel::<ExecMessage>();
    let req = ExecRequest {
        node_id: db,
        pod: pods[0].name.clone(),
        container: "db".into(),
        cols: 80,
        rows: 24,
    };
    let id = session.start_exec(req, Arc::new(tx)).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let message = loop {
        match tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("no-shell outcome in time")
            .expect("channel open")
        {
            ExecMessage::Output { .. } => continue,
            ExecMessage::Ended { message, code, .. } => break format!("{message:?} (code {code:?})"),
            ExecMessage::Error { message, .. } => break message,
        }
    };
    println!("no-shell outcome: {message}");
    assert!(message.contains("no shell"), "expected the no-shell message, got {message}");
    session.stop_exec(id).await;

    // A pod outside the workload is refused before any connection.
    let req = ExecRequest {
        node_id: talker,
        pod: "not-a-talker".into(),
        container: "talker".into(),
        cols: 80,
        rows: 24,
    };
    let err = session
        .start_exec(req, Arc::new(mpsc::unbounded_channel::<ExecMessage>().0))
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
}

/// Stream the talker's logs: a `started`, then lines containing "tick"; stopping ends the flow.
async fn exercise_logs(session: &mut Session, context: &str) {
    kubectl(
        context,
        &["-n", NAMESPACE, "rollout", "status", "deployment/talker", "--timeout=180s"],
    );
    let (tx, mut rx) = mpsc::unbounded_channel::<LogMessage>();
    let id = session
        .start_logs(
            LogRequest {
                node_id: format!("Deployment/{NAMESPACE}/talker"),
                container: None,
                previous: false,
                timestamps: true,
            },
            Arc::new(tx),
        )
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut started = false;
    let mut saw_tick = false;
    while !(started && saw_tick) {
        let msg = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("log messages in time")
            .expect("channel open");
        match msg {
            LogMessage::Started { session_id, .. } => {
                assert_eq!(session_id, id);
                started = true;
            }
            LogMessage::Lines { lines, .. } => {
                saw_tick |= lines.iter().any(|l| l.text.contains("tick"));
                // timestamps=true: each line starts with an RFC 3339 stamp.
                assert!(lines.iter().all(|l| l.text.starts_with("20")), "{lines:?}");
            }
            LogMessage::Error { message, .. } => panic!("stream error: {message}"),
            // A follow stream on a Ready pod must not end on its own; fail fast instead of
            // waiting out the deadline with a generic timeout message.
            LogMessage::Ended { pod, .. } => panic!("stream ended early: {pod}"),
            LogMessage::Truncated { .. } => {}
        }
    }
    session.stop_logs(id);
    // Drain what was in flight; after that the sender is dropped and the channel closes.
    let closed = tokio::time::timeout(Duration::from_secs(5), async { while rx.recv().await.is_some() {} }).await;
    assert!(closed.is_ok(), "streams kept running after stop_logs");

    // An unknown kind is rejected up front.
    let err = session
        .start_logs(
            LogRequest {
                node_id: format!("ConfigMap/{NAMESPACE}/web-cfg"),
                container: None,
                previous: false,
                timestamps: false,
            },
            Arc::new(mpsc::unbounded_channel::<LogMessage>().0),
        )
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid, "{err:?}");
}

/// Two namespaces in one graph and one table, then all namespaces.
async fn exercise_scopes(session: &mut Session, rx: &mut UnboundedReceiver<OutEvent>, graph: &mut Graph) {
    let both = NamespaceScope::from_arg(Some(vec![NAMESPACE.into(), NAMESPACE_B.into()])).unwrap();
    session.select_scope(both, HashSet::new()).await.unwrap();
    *graph = Graph::default();
    let b_cfg = format!("ConfigMap/{NAMESPACE_B}/b-cfg");
    let web = format!("Deployment/{NAMESPACE}/web");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let ok = graph_until(rx, graph, deadline, |g| has_node(g, &b_cfg) && has_node(g, &web)).await;
    assert!(
        ok,
        "both namespaces in one graph: {:?}",
        graph.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
    );
    let table = session.list_rows(Kind::ConfigMap, false);
    assert_eq!(table.columns[0].key, "namespace", "{:?}", table.columns);
    assert!(table.rows.iter().any(|r| r.cells[0].text == NAMESPACE_B), "{:?}", table.rows);

    session.select_scope(NamespaceScope::All, HashSet::new()).await.unwrap();
    *graph = Graph::default();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let ok = graph_until(rx, graph, deadline, |g| {
        g.too_large.is_some() || g.nodes.iter().any(|n| n.namespace.as_deref() == Some("kube-system"))
    })
    .await;
    assert!(ok, "kube-system objects with all namespaces: {} nodes", graph.nodes.len());
    eprintln!(
        "all namespaces: {} nodes, tooLarge {:?}",
        graph.nodes.len(),
        graph.too_large.as_ref().map(|t| t.nodes)
    );
}

const SMOKE_CRD: &str = "wiringsmokes.wiringsmoke.example.com";
const SMOKE_CR: &str = "Custom/wiringsmoke.example.com/v1/WiringSmoke/wiring-smoke/alpha";
const SMOKE_RELEASE: &str = "smoke-rel";

/// Deletes the smoke CRD (and with it every WiringSmoke) when dropped: at the end of the test,
/// and when anything before that panics. Never panics itself.
struct CrdGuard {
    context: String,
}

impl Drop for CrdGuard {
    fn drop(&mut self) {
        let status = Command::new("kubectl")
            .args([
                "--context",
                &self.context,
                "delete",
                "crd",
                SMOKE_CRD,
                "--ignore-not-found",
                "--wait=false",
            ])
            .status();
        if !status.is_ok_and(|s| s.success()) {
            eprintln!("could not delete crd/{SMOKE_CRD}; delete it by hand");
        }
    }
}

/// Creates the smoke CRD and its CR, or `None` (creating nothing) off docker-desktop.
fn install_smoke_crd(context: &str) -> Option<CrdGuard> {
    if context != "docker-desktop" {
        eprintln!("skipping the custom resource and Helm phase: it only runs against docker-desktop");
        return None;
    }
    // The guard exists before the CRD does, so a failing apply below still cleans up.
    let guard = CrdGuard {
        context: context.to_string(),
    };
    kubectl(context, &["delete", "crd", SMOKE_CRD, "--ignore-not-found", "--wait=true"]);
    kubectl(
        context,
        &["apply", "-f", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/smoke-crd.yaml")],
    );
    kubectl(
        context,
        &["wait", "--for=condition=Established", &format!("crd/{SMOKE_CRD}"), "--timeout=60s"],
    );
    kubectl(
        context,
        &["apply", "-f", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/smoke-cr.yaml")],
    );
    Some(guard)
}

/// A Helm 3 storage Secret for `smoke-rel` revision 1, built the way Helm writes one:
/// `data.release` = base64(base64(gzip(json))).
fn helm_secret_yaml() -> String {
    let release = serde_json::json!({
        "name": SMOKE_RELEASE, "namespace": NAMESPACE, "version": 1,
        "info": { "first_deployed": "2026-10-06T10:00:00Z", "last_deployed": "2026-10-06T10:00:00Z",
                  "description": "Install complete", "status": "deployed", "notes": "smoke notes" },
        "chart": { "metadata": { "name": "smoke", "version": "0.1.0", "appVersion": "1.0" } },
        "config": { "replicaCount": 1 }
    });
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&serde_json::to_vec(&release).unwrap()).unwrap();
    let record = STANDARD.encode(STANDARD.encode(gz.finish().unwrap()));
    format!(
        "apiVersion: v1\nkind: Secret\ntype: helm.sh/release.v1\nmetadata:\n  name: sh.helm.release.v1.{SMOKE_RELEASE}.v1\n  labels:\n    name: {SMOKE_RELEASE}\n    owner: helm\n    status: deployed\n    version: \"1\"\ndata:\n  release: {record}\n"
    )
}

/// Wait for a `custom_table` event whose rows satisfy `ok`, applying graph events on the way.
async fn custom_table_until(
    rx: &mut UnboundedReceiver<OutEvent>,
    graph: &mut Graph,
    deadline: tokio::time::Instant,
    ok: impl Fn(&CustomTable) -> bool,
) -> bool {
    loop {
        let Ok(ev) = tokio::time::timeout_at(deadline, rx.recv()).await else {
            return false;
        };
        match ev.expect("emitter open") {
            OutEvent::CustomTable(t) if ok(&t) => return true,
            OutEvent::GraphSnapshot(g) => *graph = g,
            OutEvent::GraphDelta(d) => apply_delta(graph, d),
            _ => {}
        }
    }
}

/// The smoke CRD's kind, table, live watch, edits, a CR owner on the graph, and a Helm release.
/// Takes the session by value: discovery and the table go through the commands' own entry
/// points, which work on the app's `Mutex<Option<Session>>`.
async fn exercise_custom_and_helm(session: Session, rx: &mut UnboundedReceiver<OutEvent>, graph: &mut Graph, context: &str) -> Session {
    // Discovery finds the smoke kind with its printer columns.
    let sessions = Mutex::new(Some(session));
    let bound = resolve_kind(&sessions, "wiringsmoke.example.com", "", "WiringSmoke", discovery::discover)
        .await
        .expect("the smoke CRD is discovered");
    let (kind, client) = (bound.kind, bound.client);
    assert!(kind.resource.namespaced);
    assert_eq!(kind.resource.plural, "wiringsmokes");
    assert_eq!(kind.resource.version, "v1");
    assert_eq!(
        kind.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["Size", "Age"]
    );

    // Its table (Name, Size, Age), then the live watch the list started.
    let listed = kind.clone();
    let table = list_custom(&sessions, move || async move { Ok(listed) }).await.unwrap();
    let row = table
        .table
        .rows
        .iter()
        .find(|r| r.node_id == SMOKE_CR)
        .unwrap_or_else(|| panic!("alpha in {:?}", table.table.rows));
    assert_eq!(row.cells[1].text, "small", "{:?}", row.cells);
    let mut session = sessions.into_inner().expect("the session is still there");
    assert_eq!(session.open_custom(), Some(&kind.resource));
    kubectl(
        context,
        &[
            "-n",
            NAMESPACE,
            "patch",
            "wiringsmoke",
            "alpha",
            "--type=merge",
            "-p",
            r#"{"spec":{"size":"medium"}}"#,
        ],
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let ok = custom_table_until(rx, graph, deadline, |t| {
        t.table.rows.iter().any(|r| r.node_id == SMOKE_CR && r.cells[1].text == "medium")
    })
    .await;
    assert!(ok, "the watched custom table never showed the patch");
    session.stop_custom();
    assert!(session.open_custom().is_none());

    // YAML edit through the dynamic API, and a stale edit is a conflict.
    let id = CustomId::parse(SMOKE_CR).unwrap();
    let details = ops::get(&client, &kind, &id).await.unwrap();
    assert!(details.yaml.contains("kind: WiringSmoke"), "{}", details.yaml);
    let edited = details.yaml.replace("size: medium", "size: large");
    assert_ne!(edited, details.yaml, "{}", details.yaml);
    let saved = ops::update(&client, &kind, &id, &edited, false).await.unwrap();
    assert!(saved.yaml.contains("size: large"), "{}", saved.yaml);
    let stale = ops::update(&client, &kind, &id, &edited, false).await.unwrap_err();
    assert_eq!(stale.kind, ErrorKind::Conflict, "{stale:?}");

    // Create and delete a second one; the selected namespace fills in the missing one.
    let beta =
        manifest::parse_raw("apiVersion: wiringsmoke.example.com/v1\nkind: WiringSmoke\nmetadata:\n  name: beta\nspec:\n  size: tiny\n")
            .unwrap();
    let beta_id = ops::create(&client, &kind, beta, NAMESPACE).await.unwrap();
    assert_eq!(beta_id, "Custom/wiringsmoke.example.com/v1/WiringSmoke/wiring-smoke/beta");
    let beta_id = CustomId::parse(&beta_id).unwrap();
    ops::delete(&client, &kind, &beta_id).await.unwrap();
    ops::delete(&client, &kind, &beta_id).await.unwrap(); // already gone is not an error

    // A ConfigMap owned by the CR puts the CR on the graph as its owner.
    let uid = serde_yaml_ng::from_str::<serde_json::Value>(&saved.yaml).unwrap()["metadata"]["uid"]
        .as_str()
        .unwrap()
        .to_string();
    session
        .create_object(
            NAMESPACE,
            &format!(
                "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cr-child\n  ownerReferences:\n  - apiVersion: wiringsmoke.example.com/v1\n    kind: WiringSmoke\n    name: alpha\n    uid: {uid}\ndata:\n  a: b\n"
            ),
        )
        .await
        .unwrap();
    let child = format!("ConfigMap/{NAMESPACE}/cr-child");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let ok = graph_until(rx, graph, deadline, |g| {
        g.node(SMOKE_CR).is_some_and(|n| n.kind == Kind::Custom)
            && g.edges
                .iter()
                .any(|e| e.source == SMOKE_CR && e.target == child && e.relation == Relation::Owns)
    })
    .await;
    assert!(
        ok,
        "the CR owner never reached the graph: {:?}",
        graph.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
    );

    // A Helm release: one annotated ConfigMap and its storage Secret.
    session
        .create_object(
            NAMESPACE,
            &format!("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: helm-cfg\n  annotations:\n    meta.helm.sh/release-name: {SMOKE_RELEASE}\n    meta.helm.sh/release-namespace: {NAMESPACE}\n"),
        )
        .await
        .unwrap();
    session.create_object(NAMESPACE, &helm_secret_yaml()).await.unwrap();
    let shared = session.shared_handle();
    let helm_cfg = format!("ConfigMap/{NAMESPACE}/helm-cfg");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let release = loop {
        if let Some(r) = shared.helm_releases().into_iter().find(|r| r.name == SMOKE_RELEASE) {
            if shared
                .helm_release(NAMESPACE, SMOKE_RELEASE)
                .is_ok_and(|d| d.resources.contains(&helm_cfg))
            {
                break r;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the Helm release never listed with its ConfigMap: {:?}",
            shared.helm_releases()
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    assert_eq!(
        (release.chart.as_str(), release.revision, release.health),
        ("smoke-0.1.0", 1, Status::Ok),
        "{release:?}"
    );
    let d = shared.helm_release(NAMESPACE, SMOKE_RELEASE).unwrap();
    assert_eq!(d.values, "replicaCount: 1\n");
    assert_eq!(d.notes, "smoke notes");

    // The storage Secret stays out of the graph and, unless asked for, the Secrets table.
    let storage = format!("sh.helm.release.v1.{SMOKE_RELEASE}.v1");
    let names = |include: bool| -> Vec<String> {
        session
            .list_rows(Kind::Secret, include)
            .rows
            .into_iter()
            .map(|r| r.cells[0].text.clone())
            .collect()
    };
    assert!(!names(false).contains(&storage), "{:?}", names(false));
    assert!(names(true).contains(&storage), "{:?}", names(true));
    assert!(graph.node(&format!("Secret/{NAMESPACE}/{storage}")).is_none());
    session
}

/// Prints how long each phase took (and the total), to spot the slow ones in CI logs.
struct Phases {
    begin: std::time::Instant,
    last: std::time::Instant,
}

impl Phases {
    fn start() -> Self {
        let now = std::time::Instant::now();
        Self { begin: now, last: now }
    }

    fn done(&mut self, name: &str) {
        let now = std::time::Instant::now();
        eprintln!(
            "phase {name}: {:.1}s (total {:.1}s)",
            (now - self.last).as_secs_f64(),
            (now - self.begin).as_secs_f64()
        );
        self.last = now;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn graph_snapshot_reflects_applied_fixture() {
    let context = std::env::var("WIRING_SMOKE_CONTEXT").expect("set WIRING_SMOKE_CONTEXT");
    let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/smoke.yaml");
    let mut phases = Phases::start();
    // Idempotent re-runs: a namespace left over from an aborted run is still terminating.
    kubectl(&context, &["delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=true"]);
    kubectl(&context, &["delete", "namespace", NAMESPACE_B, "--ignore-not-found", "--wait=true"]);
    kubectl(&context, &["apply", "-f", fixture]);
    kubectl(
        &context,
        &["apply", "-f", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/smoke-b.yaml")],
    );
    let crd_guard = install_smoke_crd(&context);
    kubectl(
        &context,
        &["-n", NAMESPACE, "rollout", "status", "deployment/web", "--timeout=180s"],
    );
    kubectl(
        &context,
        &["-n", NAMESPACE, "rollout", "status", "statefulset/db", "--timeout=180s"],
    );
    // The metrics, logs and exec phases all use the talker pod.
    kubectl(
        &context,
        &["-n", NAMESPACE, "rollout", "status", "deployment/talker", "--timeout=180s"],
    );
    phases.done("setup");

    let merged = kubeconfig::load_merged(&kubeconfig::default_paths()).unwrap();
    let (emitter, mut rx) = ChannelEmitter::new();
    let (mut session, info) = Session::connect(merged, &context, Arc::new(emitter)).await.unwrap();
    assert!(info.namespaces.contains(&NAMESPACE.to_string()));
    session
        .select_scope(NamespaceScope::single(NAMESPACE).unwrap(), HashSet::new())
        .await
        .unwrap();

    // The reducer announces `connected` first; a `disconnected` here would mean a torn-down
    // session leaked its final state into the new one.
    let first = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("an event after select_scope")
        .expect("emitter open");
    assert_ne!(first, OutEvent::ConnectionState(ConnectionState::Disconnected));
    assert_eq!(first, OutEvent::ConnectionState(ConnectionState::Connected));

    let mut graph = Graph::default();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let ok = graph_until(&mut rx, &mut graph, deadline, fixture_is_live).await;
    assert!(ok, "fixture never fully appeared in the graph; last graph: {graph:#?}");

    // A pod that cannot pull its image explains its Deployment.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let ok = graph_until(&mut rx, &mut graph, deadline, |g| {
        root_problem(g, "Deployment/wiring-smoke/broken").is_some_and(|p| p.reason == "ImagePullBackOff" || p.reason == "ErrImagePull")
    })
    .await;
    assert!(ok, "the broken image never explained its Deployment; last graph: {graph:#?}");
    phases.done("graph");

    // Policies, RBAC and the node this runs on are wired up.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let ok = graph_until(&mut rx, &mut graph, deadline, |g| {
        let edge = |rel: &str, src: &str| g.edges.iter().any(|e| e.relation.as_str() == rel && e.source.starts_with(src));
        edge("applies", "NetworkPolicy/wiring-smoke/web-from-talker")
            && edge("allows", "Pod/wiring-smoke/talker")
            && edge("grants", "RoleBinding/wiring-smoke/default-reads-pods")
            && edge("subject", "RoleBinding/wiring-smoke/default-reads-pods")
            && g.edges
                .iter()
                .any(|e| e.relation.as_str() == "runsOn" && e.target.starts_with("Node//"))
            && g.nodes.iter().any(|n| n.kind == Kind::Node && n.status == Status::Ok)
    })
    .await;
    assert!(ok, "policy / RBAC / node edges never appeared; last graph: {graph:#?}");
    phases.done("graph extras");

    // Details for the deployment must render YAML + summary.
    let details = session.get_object("Deployment/wiring-smoke/web").unwrap();
    assert!(details.yaml.contains("kind: Deployment"));
    assert!(details.summary.iter().any(|(k, _)| k == "Replicas"));

    // Scale down and expect deltas to remove a pod.
    kubectl(&context, &["-n", NAMESPACE, "scale", "deployment/web", "--replicas=1"]);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    let ok = graph_until(&mut rx, &mut graph, deadline, |g| web_pod_count(g) == 1).await;
    assert!(ok, "scale-down never reached the graph; last graph: {graph:#?}");
    phases.done("details + scale-down");

    exercise_writes(&session, &mut rx, &mut graph, &context).await;
    phases.done("writes");
    exercise_rollout(&session, &mut rx, &mut graph, &context).await;
    phases.done("rollout");
    exercise_forward(&mut session, &context).await;
    phases.done("forward");
    exercise_logs(&mut session, &context).await;
    phases.done("logs");
    exercise_exec(&mut session, &context).await;
    phases.done("exec");
    exercise_metrics(&session, &context).await;
    phases.done("metrics");
    // Before the scopes phase, which switches the scope away from the smoke namespace.
    if crd_guard.is_some() {
        session = exercise_custom_and_helm(session, &mut rx, &mut graph, &context).await;
        phases.done("custom resources + helm");
    }
    exercise_scopes(&mut session, &mut rx, &mut graph).await;
    phases.done("scopes");

    session.shutdown().await;
    kubectl(&context, &["delete", "namespace", NAMESPACE, "--wait=false"]);
    kubectl(&context, &["delete", "namespace", NAMESPACE_B, "--wait=false"]);
    drop(crd_guard); // deletes the smoke CRD; on a panic above, unwinding drops it too
}
