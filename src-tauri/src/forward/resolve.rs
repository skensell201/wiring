//! Pure helpers for port-forwarding: which node ids can be forwarded, the ports a target
//! offers, which pod serves a connection and which local port to suggest.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::{Container, Pod, PodSpec, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::graph::status::pod_ready;
use crate::session::parse_node_id;
use crate::store::{Kind, Object, Store};

use super::{ForwardTarget, PortOption};

pub const FORWARD_KINDS: [Kind; 5] = [Kind::Pod, Kind::Service, Kind::Deployment, Kind::StatefulSet, Kind::DaemonSet];

/// The forward target behind `node_id`; other kinds (and PodGroups) are `invalid`.
pub fn target(node_id: &str) -> AppResult<ForwardTarget> {
    let (kind, namespace, name) = parse_node_id(node_id)?;
    if !FORWARD_KINDS.contains(&kind) {
        return Err(AppError::new(
            ErrorKind::Invalid,
            format!("{} cannot be port-forwarded", kind.as_str()),
        ));
    }
    let namespace = namespace.ok_or_else(|| AppError::new(ErrorKind::Invalid, format!("`{node_id}` has no namespace")))?;
    Ok(ForwardTarget { kind, namespace, name })
}

/// TCP container ports, labelled `8080 (http, app)` or `9090 (side)`.
fn container_ports(spec: Option<&PodSpec>) -> Vec<PortOption> {
    let containers: &[Container] = spec.map(|s| s.containers.as_slice()).unwrap_or_default();
    containers
        .iter()
        .flat_map(|c| c.ports.as_deref().unwrap_or_default().iter().map(move |p| (c, p)))
        .filter(|(_, p)| p.protocol.as_deref().is_none_or(|pr| pr == "TCP"))
        .filter_map(|(c, p)| {
            let port = u16::try_from(p.container_port).ok()?;
            let label = match &p.name {
                Some(n) => format!("{port} ({n}, {})", c.name),
                None => format!("{port} ({})", c.name),
            };
            Some(PortOption { port, label })
        })
        .collect()
}

/// The remote ports the dialog offers for `t`, from the cached store.
pub fn ports(store: &Store, t: &ForwardTarget) -> AppResult<Vec<PortOption>> {
    let obj = store.find(t.kind, Some(&t.namespace), &t.name).ok_or_else(|| {
        AppError::new(
            ErrorKind::NotFound,
            format!("{}/{}/{} not in store", t.kind.as_str(), t.namespace, t.name),
        )
    })?;
    Ok(match obj {
        Object::Pod(p) => container_ports(p.spec.as_ref()),
        Object::Deployment(d) => container_ports(d.spec.as_ref().and_then(|s| s.template.spec.as_ref())),
        Object::StatefulSet(s) => container_ports(s.spec.as_ref().and_then(|s| s.template.spec.as_ref())),
        Object::DaemonSet(d) => container_ports(d.spec.as_ref().and_then(|s| s.template.spec.as_ref())),
        Object::Service(s) => s
            .spec
            .as_ref()
            .and_then(|sp| sp.ports.as_deref())
            .unwrap_or_default()
            .iter()
            .filter(|p| p.protocol.as_deref().is_none_or(|pr| pr == "TCP"))
            .filter_map(|p| {
                let port = u16::try_from(p.port).ok()?;
                let target = match &p.target_port {
                    Some(IntOrString::Int(n)) => n.to_string(),
                    Some(IntOrString::String(s)) => s.clone(),
                    None => port.to_string(),
                };
                let name = p.name.as_deref().map(|n| format!(" ({n})")).unwrap_or_default();
                Some(PortOption {
                    port,
                    label: format!("{port} → {target}{name}"),
                })
            })
            .collect(),
        _ => vec![],
    })
}

/// A pod that can take a connection: Running, Ready and not being deleted.
pub fn serving(p: &Pod) -> bool {
    p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running") && pod_ready(p)
}

/// The serving pod with the smallest name, so consecutive connections stick to one pod.
pub fn pick_pod(pods: &[Pod]) -> Option<&Pod> {
    pods.iter()
        .filter(|p| serving(p))
        .min_by(|a, b| a.metadata.name.cmp(&b.metadata.name))
}

/// The container port Service port `port` reaches on `pod`: a numeric targetPort as is, a named
/// one looked up in the pod's containers, none at all means the same number.
pub fn service_target_port(svc: &Service, port: u16, pod: &Pod) -> Result<u16, String> {
    let sp = svc
        .spec
        .as_ref()
        .and_then(|s| s.ports.as_deref())
        .and_then(|ps| ps.iter().find(|p| p.port == i32::from(port)))
        .ok_or_else(|| format!("service has no port {port}"))?;
    match &sp.target_port {
        None => Ok(port),
        Some(IntOrString::Int(n)) => u16::try_from(*n).map_err(|_| format!("bad targetPort {n}")),
        Some(IntOrString::String(name)) => pod
            .spec
            .iter()
            .flat_map(|s| s.containers.iter())
            .flat_map(|c| c.ports.as_deref().unwrap_or_default())
            .find(|p| p.name.as_deref() == Some(name.as_str()))
            .and_then(|p| u16::try_from(p.container_port).ok())
            .ok_or_else(|| format!("pod {} has no port named {name}", pod.metadata.name.as_deref().unwrap_or_default())),
    }
}

/// `a=1,b=2` for a pod list; `None` for an empty selector, which would match every pod.
pub fn selector_string(labels: &BTreeMap<String, String>) -> Option<String> {
    if labels.is_empty() {
        return None;
    }
    Some(labels.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(","))
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// `port` itself when it is unprivileged and free, else the first free port from 8080 (0 if none).
pub fn suggest_local_port(port: u16) -> u16 {
    if port >= 1024 && port_free(port) {
        return port;
    }
    (8080..=u16::MAX).find(|p| port_free(*p)).unwrap_or(0)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod(name: &str, phase: &str, ready: bool) -> Pod {
        serde_json::from_value(json!({
            "metadata": { "name": name },
            "spec": { "containers": [ { "name": "app", "ports": [ { "name": "http", "containerPort": 8080 } ] } ] },
            "status": { "phase": phase, "conditions": [ { "type": "Ready", "status": if ready { "True" } else { "False" } } ] }
        }))
        .unwrap()
    }

    fn service(ports: serde_json::Value) -> Service {
        serde_json::from_value(json!({ "metadata": { "name": "s" }, "spec": { "ports": ports } })).unwrap()
    }

    const YAML: &str = r#"
apiVersion: v1
kind: Pod
metadata: { name: p, namespace: ns }
spec:
  containers:
    - name: app
      ports: [ { name: http, containerPort: 8080 }, { containerPort: 53, protocol: UDP } ]
    - name: side
      ports: [ { containerPort: 9090 } ]
---
apiVersion: v1
kind: Service
metadata: { name: s, namespace: ns }
spec: { ports: [ { name: web, port: 80, targetPort: http }, { port: 443 }, { port: 53, protocol: UDP } ] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: d, namespace: ns }
spec:
  selector: { matchLabels: { app: d } }
  template: { metadata: { labels: { app: d } }, spec: { containers: [ { name: d, ports: [ { containerPort: 3000 } ] } ] } }
"#;

    fn opts(v: &[PortOption]) -> Vec<(u16, &str)> {
        v.iter().map(|o| (o.port, o.label.as_str())).collect()
    }

    #[test]
    fn targets_are_the_five_forwardable_kinds_with_a_namespace() {
        assert_eq!(
            target("Service/ns/s").unwrap(),
            ForwardTarget {
                kind: Kind::Service,
                namespace: "ns".into(),
                name: "s".into()
            }
        );
        for ok in ["Pod/ns/p", "Deployment/ns/d", "StatefulSet/ns/s", "DaemonSet/ns/d"] {
            assert!(target(ok).is_ok(), "{ok}");
        }
        for bad in ["ConfigMap/ns/c", "PodGroup/ns/Deployment/d", "Pod//p"] {
            assert_eq!(target(bad).unwrap_err().kind, ErrorKind::Invalid, "{bad}");
        }
    }

    #[test]
    fn ports_list_tcp_ports_per_kind() {
        let store = Store::from_yaml_docs(YAML).unwrap();
        let t = |id: &str| target(id).unwrap();
        assert_eq!(
            opts(&ports(&store, &t("Pod/ns/p")).unwrap()),
            vec![(8080, "8080 (http, app)"), (9090, "9090 (side)")]
        );
        assert_eq!(
            opts(&ports(&store, &t("Service/ns/s")).unwrap()),
            vec![(80, "80 → http (web)"), (443, "443 → 443")]
        );
        assert_eq!(opts(&ports(&store, &t("Deployment/ns/d")).unwrap()), vec![(3000, "3000 (d)")]);
        assert_eq!(ports(&store, &t("Pod/ns/missing")).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn only_running_ready_pods_serve_and_the_smallest_name_wins() {
        let mut deleting = pod("a-deleting", "Running", true);
        deleting.metadata.deletion_timestamp = Some(serde_json::from_value(json!("2026-10-05T10:00:00Z")).unwrap());
        let pods = vec![
            pod("c", "Running", true),
            pod("a-pending", "Pending", true),
            deleting,
            pod("a-unready", "Running", false),
            pod("b", "Running", true),
        ];
        assert_eq!(pick_pod(&pods).and_then(|p| p.metadata.name.as_deref()), Some("b"));
        assert!(pick_pod(&pods[1..4]).is_none());
    }

    #[test]
    fn service_ports_map_to_the_pods_target_port() {
        let p = pod("web-1", "Running", true);
        let svc = service(
            json!([ { "port": 80, "targetPort": "http" }, { "port": 81, "targetPort": 9000 }, { "port": 82 }, { "port": 83, "targetPort": "nope" } ]),
        );
        assert_eq!(service_target_port(&svc, 80, &p), Ok(8080));
        assert_eq!(service_target_port(&svc, 81, &p), Ok(9000));
        assert_eq!(service_target_port(&svc, 82, &p), Ok(82));
        assert_eq!(service_target_port(&svc, 83, &p), Err("pod web-1 has no port named nope".into()));
        assert_eq!(service_target_port(&svc, 99, &p), Err("service has no port 99".into()));
    }

    #[test]
    fn selector_strings_join_labels_and_refuse_empty_selectors() {
        let labels = BTreeMap::from([("b".to_string(), "2".to_string()), ("a".to_string(), "1".to_string())]);
        assert_eq!(selector_string(&labels).as_deref(), Some("a=1,b=2"));
        assert_eq!(selector_string(&BTreeMap::new()), None);
    }

    #[test]
    fn local_port_suggestions_skip_taken_and_privileged_ports() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        assert_ne!(suggest_local_port(port), port);
        drop(taken);
        assert_eq!(suggest_local_port(port), port);
        assert!(suggest_local_port(80) >= 8080);
    }
}
