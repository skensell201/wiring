//! kubectl-like tables per kind, computed from the Store.

use std::collections::HashMap;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use k8s_openapi::jiff;
use serde::{Deserialize, Serialize};

use super::model::{node_id, NodeId, Status};
use super::status::{describe_with, PolicyPods};
use crate::metrics::usage::PodIndex;
use crate::store::{Kind, Object, Store};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableColumn {
    pub key: String,
    pub label: String,
    pub numeric: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableCell {
    pub text: String,
    pub status: Option<Status>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRow {
    pub node_id: NodeId,
    pub status: Status,
    pub cells: Vec<TableCell>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Table {
    pub kind: Kind,
    pub columns: Vec<TableColumn>,
    pub rows: Vec<TableRow>,
}

fn col(key: &str, label: &str, numeric: bool) -> TableColumn {
    TableColumn {
        key: key.into(),
        label: label.into(),
        numeric,
    }
}
fn plain(text: impl Into<String>) -> TableCell {
    TableCell {
        text: text.into(),
        status: None,
    }
}
fn coloured(text: impl Into<String>, status: Status) -> TableCell {
    TableCell {
        text: text.into(),
        status: Some(status),
    }
}

/// `table` with a leading Namespace column, for a scope of several namespaces; rows sort by
/// namespace, then name. Cluster-scoped objects show `—`.
pub fn with_namespace_column(mut table: Table) -> Table {
    table.columns.insert(0, col("namespace", "Namespace", false));
    for row in &mut table.rows {
        let ns = row.node_id.split('/').nth(1).unwrap_or_default();
        row.cells.insert(0, plain(if ns.is_empty() { "—" } else { ns }));
    }
    table
        .rows
        .sort_by(|a, b| (&a.cells[0].text, &a.cells[1].text).cmp(&(&b.cells[0].text, &b.cells[1].text)));
    table
}

/// kubectl-style relative age.
pub fn age(created: Option<&Time>, now: jiff::Timestamp) -> String {
    let Some(t) = created else { return "—".into() };
    let secs = now.as_second() - t.0.as_second();
    let secs = secs.max(0);
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}

pub fn columns(kind: Kind) -> Vec<TableColumn> {
    let name = || col("name", "Name", false);
    let age_c = || col("age", "Age", true);
    let cpu = || col("cpu", "CPU", true);
    let memory = || col("memory", "Memory", true);
    match kind {
        Kind::Pod => vec![
            name(),
            col("ready", "Ready", false),
            col("status", "Status", false),
            col("restarts", "Restarts", true),
            cpu(),
            memory(),
            age_c(),
            col("node", "Node", false),
            col("ip", "IP", false),
        ],
        Kind::Deployment => vec![
            name(),
            col("ready", "Ready", false),
            col("upToDate", "Up-to-date", true),
            col("available", "Available", true),
            cpu(),
            memory(),
            age_c(),
            col("images", "Images", false),
        ],
        Kind::StatefulSet => vec![
            name(),
            col("ready", "Ready", false),
            cpu(),
            memory(),
            age_c(),
            col("images", "Images", false),
        ],
        Kind::DaemonSet => vec![
            name(),
            col("desired", "Desired", true),
            col("ready", "Ready", true),
            cpu(),
            memory(),
            age_c(),
            col("images", "Images", false),
        ],
        Kind::ReplicaSet => vec![
            name(),
            col("desired", "Desired", true),
            col("current", "Current", true),
            col("ready", "Ready", true),
            age_c(),
        ],
        Kind::Job => vec![name(), col("completions", "Completions", false), age_c()],
        Kind::CronJob => vec![
            name(),
            col("schedule", "Schedule", false),
            col("suspend", "Suspend", false),
            col("active", "Active", true),
            col("lastSchedule", "Last schedule", true),
            age_c(),
        ],
        Kind::ConfigMap => vec![name(), col("keys", "Keys", true), age_c()],
        Kind::Secret => vec![name(), col("type", "Type", false), col("keys", "Keys", true), age_c()],
        Kind::HorizontalPodAutoscaler => vec![
            name(),
            col("target", "Target", false),
            col("min", "Min", true),
            col("max", "Max", true),
            col("replicas", "Replicas", true),
            age_c(),
        ],
        Kind::Service => vec![
            name(),
            col("type", "Type", false),
            col("clusterIp", "Cluster IP", false),
            col("ports", "Ports", false),
            age_c(),
        ],
        Kind::Ingress => vec![name(), col("class", "Class", false), col("hosts", "Hosts", false), age_c()],
        Kind::PersistentVolumeClaim => vec![
            name(),
            col("status", "Status", false),
            col("volume", "Volume", false),
            col("capacity", "Capacity", false),
            col("accessModes", "Access modes", false),
            col("storageClass", "StorageClass", false),
            age_c(),
        ],
        Kind::PersistentVolume => vec![
            name(),
            col("capacity", "Capacity", false),
            col("accessModes", "Access modes", false),
            col("reclaim", "Reclaim", false),
            col("status", "Status", false),
            col("claim", "Claim", false),
            col("storageClass", "StorageClass", false),
            age_c(),
        ],
        Kind::ServiceAccount => vec![name(), age_c()],
        Kind::NetworkPolicy => vec![
            name(),
            col("podSelector", "Pod selector", false),
            col("policyTypes", "Policy types", false),
            age_c(),
        ],
        Kind::Role | Kind::ClusterRole => vec![name(), col("rules", "Rules", true), age_c()],
        Kind::RoleBinding | Kind::ClusterRoleBinding => {
            vec![name(), col("role", "Role", false), col("subjects", "Subjects", false), age_c()]
        }
        Kind::Node => vec![
            name(),
            col("status", "Status", false),
            col("roles", "Roles", false),
            col("version", "Version", false),
            col("pods", "Pods", true),
            age_c(),
        ],
        Kind::PodGroup => vec![],
    }
}

/// Build the table for `kind` from the store. Rows sorted by name.
pub fn table(store: &Store, kind: Kind, now: jiff::Timestamp) -> Table {
    let columns = columns(kind);
    let pods = if crate::metrics::usage::has_usage(kind) {
        PodIndex::new(store)
    } else {
        PodIndex::default()
    };
    let policy_pods = PolicyPods::new(store, store.iter_kind(kind));
    // nodeName -> how many pods it hosts, for the Node table's pods column.
    let mut node_pods: HashMap<&str, usize> = HashMap::new();
    if kind == Kind::Node {
        for obj in store.iter_kind(Kind::Pod) {
            if let Object::Pod(p) = obj {
                if let Some(n) = p.spec.as_ref().and_then(|s| s.node_name.as_deref()) {
                    *node_pods.entry(n).or_default() += 1;
                }
            }
        }
    }
    let mut rows: Vec<TableRow> = store
        .iter_kind(kind)
        .map(|obj| {
            let (status, badges) = describe_with(obj, store, &pods, &policy_pods);
            let mut cells = vec![plain(obj.name())];
            cells.extend(kind_cells(obj, store, &pods, &node_pods, &badges, status, now));
            TableRow {
                node_id: node_id(kind, obj.namespace(), obj.name()),
                status,
                cells,
            }
        })
        .collect();
    rows.sort_by(|a, b| a.cells[0].text.cmp(&b.cells[0].text));
    Table { kind, columns, rows }
}

fn images(containers: &[k8s_openapi::api::core::v1::Container]) -> String {
    containers.iter().filter_map(|c| c.image.clone()).collect::<Vec<_>>().join(", ")
}

fn join<T: ToString>(items: Option<&Vec<T>>) -> String {
    items
        .map(|v| v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))
        .unwrap_or_default()
}

/// `ServiceAccount s/web, User alice`.
pub(crate) fn subjects_text(subjects: &[k8s_openapi::api::rbac::v1::Subject]) -> String {
    subjects
        .iter()
        .map(|s| match &s.namespace {
            Some(ns) => format!("{} {ns}/{}", s.kind, s.name),
            None => format!("{} {}", s.kind, s.name),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `Ready`, `NotReady` (Ready condition not True) or `Unknown` (no Ready condition).
pub(crate) fn node_ready_text(n: &k8s_openapi::api::core::v1::Node) -> String {
    let ready = n
        .status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .and_then(|cs| cs.iter().find(|c| c.type_ == "Ready"));
    match ready {
        Some(c) if c.status == "True" => "Ready".into(),
        Some(_) => "NotReady".into(),
        None => "Unknown".into(),
    }
}

/// Whether the node is cordoned (`kubectl cordon` sets `spec.unschedulable`).
pub(crate) fn node_cordoned(n: &k8s_openapi::api::core::v1::Node) -> bool {
    n.spec.as_ref().and_then(|s| s.unschedulable).unwrap_or(false)
}

/// The STATUS column as kubectl prints it: `Ready`, `NotReady,SchedulingDisabled`, ...
pub(crate) fn node_status_text(n: &k8s_openapi::api::core::v1::Node) -> String {
    let ready = node_ready_text(n);
    if node_cordoned(n) {
        format!("{ready},SchedulingDisabled")
    } else {
        ready
    }
}

/// Roles from `node-role.kubernetes.io/<role>` labels, `<none>` like kubectl.
pub(crate) fn node_roles(n: &k8s_openapi::api::core::v1::Node) -> String {
    let roles: Vec<&str> = n
        .metadata
        .labels
        .iter()
        .flatten()
        .filter_map(|(k, _)| k.strip_prefix("node-role.kubernetes.io/"))
        .collect();
    if roles.is_empty() {
        "<none>".into()
    } else {
        roles.join(",")
    }
}

fn kind_cells<'a>(
    obj: &'a Object,
    store: &'a Store,
    pods: &PodIndex<'a>,
    node_pods: &HashMap<&str, usize>,
    badges: &[String],
    status: Status,
    now: jiff::Timestamp,
) -> Vec<TableCell> {
    let created = obj.meta().creation_timestamp.as_ref();
    let age_cell = plain(age(created, now));
    let (cpu, memory) = crate::metrics::usage::usage_cells(store, pods, obj);
    let (cpu, memory) = (plain(cpu), plain(memory));
    match obj {
        Object::Pod(p) => {
            let st = p.status.as_ref();
            let statuses = st.and_then(|s| s.container_statuses.as_ref()).cloned().unwrap_or_default();
            let total = p.spec.as_ref().map(|s| s.containers.len()).unwrap_or(0);
            let ready = statuses.iter().filter(|c| c.ready).count();
            let restarts: i32 = statuses.iter().map(|c| c.restart_count).sum();
            let label = badges.first().cloned().unwrap_or_default();
            vec![
                plain(format!("{ready}/{total}")),
                coloured(label, status),
                plain(restarts.to_string()),
                cpu,
                memory,
                age_cell,
                plain(p.spec.as_ref().and_then(|s| s.node_name.clone()).unwrap_or_default()),
                plain(st.and_then(|s| s.pod_ip.clone()).unwrap_or_default()),
            ]
        }
        Object::Deployment(d) => {
            let st = d.status.as_ref();
            let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let ready = st.and_then(|s| s.ready_replicas).unwrap_or(0);
            vec![
                coloured(format!("{ready}/{desired}"), status),
                plain(st.and_then(|s| s.updated_replicas).unwrap_or(0).to_string()),
                plain(st.and_then(|s| s.available_replicas).unwrap_or(0).to_string()),
                cpu,
                memory,
                age_cell,
                plain(
                    d.spec
                        .as_ref()
                        .and_then(|s| s.template.spec.as_ref())
                        .map(|ps| images(&ps.containers))
                        .unwrap_or_default(),
                ),
            ]
        }
        Object::StatefulSet(s) => {
            let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let ready = s.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
            vec![
                coloured(format!("{ready}/{desired}"), status),
                cpu,
                memory,
                age_cell,
                plain(
                    s.spec
                        .as_ref()
                        .and_then(|s| s.template.spec.as_ref())
                        .map(|ps| images(&ps.containers))
                        .unwrap_or_default(),
                ),
            ]
        }
        Object::DaemonSet(d) => {
            let st = d.status.as_ref();
            vec![
                plain(st.map(|s| s.desired_number_scheduled).unwrap_or(0).to_string()),
                coloured(st.map(|s| s.number_ready).unwrap_or(0).to_string(), status),
                cpu,
                memory,
                age_cell,
                plain(
                    d.spec
                        .as_ref()
                        .and_then(|s| s.template.spec.as_ref())
                        .map(|ps| images(&ps.containers))
                        .unwrap_or_default(),
                ),
            ]
        }
        Object::ReplicaSet(r) => {
            let st = r.status.as_ref();
            vec![
                plain(r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1).to_string()),
                plain(st.map(|s| s.replicas).unwrap_or(0).to_string()),
                coloured(st.and_then(|s| s.ready_replicas).unwrap_or(0).to_string(), status),
                age_cell,
            ]
        }
        Object::Job(_) => vec![coloured(badges.first().cloned().unwrap_or_default(), status), age_cell],
        Object::CronJob(c) => {
            let st = c.status.as_ref();
            vec![
                plain(c.spec.schedule.clone()),
                plain(c.spec.suspend.unwrap_or(false).to_string()),
                plain(st.and_then(|s| s.active.as_ref()).map(|a| a.len()).unwrap_or(0).to_string()),
                plain(age(st.and_then(|s| s.last_schedule_time.as_ref()), now)),
                age_cell,
            ]
        }
        Object::ConfigMap(c) => vec![
            plain((c.data.as_ref().map_or(0, |d| d.len()) + c.binary_data.as_ref().map_or(0, |d| d.len())).to_string()),
            age_cell,
        ],
        Object::Secret(s) => vec![
            plain(s.type_.clone().unwrap_or_default()),
            plain((s.data.as_ref().map_or(0, |d| d.len()) + s.string_data.as_ref().map_or(0, |d| d.len())).to_string()),
            age_cell,
        ],
        Object::HorizontalPodAutoscaler(h) => {
            let st = h.status.as_ref();
            vec![
                plain(format!("{}/{}", h.spec.scale_target_ref.kind, h.spec.scale_target_ref.name)),
                plain(h.spec.min_replicas.unwrap_or(1).to_string()),
                plain(h.spec.max_replicas.to_string()),
                coloured(st.and_then(|s| s.current_replicas).unwrap_or(0).to_string(), status),
                age_cell,
            ]
        }
        Object::Service(s) => {
            let spec = s.spec.as_ref();
            let ports = spec
                .and_then(|s| s.ports.as_ref())
                .map(|ps| {
                    ps.iter()
                        .map(|p| format!("{}/{}", p.port, p.protocol.clone().unwrap_or_else(|| "TCP".into())))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            vec![
                plain(spec.and_then(|s| s.type_.clone()).unwrap_or_else(|| "ClusterIP".into())),
                plain(spec.and_then(|s| s.cluster_ip.clone()).unwrap_or_default()),
                plain(ports),
                age_cell,
            ]
        }
        Object::Ingress(i) => {
            let spec = i.spec.as_ref();
            let hosts = spec
                .and_then(|s| s.rules.as_ref())
                .map(|r| r.iter().filter_map(|r| r.host.clone()).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            vec![
                plain(spec.and_then(|s| s.ingress_class_name.clone()).unwrap_or_default()),
                plain(hosts),
                age_cell,
            ]
        }
        Object::PersistentVolumeClaim(p) => {
            let spec = p.spec.as_ref();
            let st = p.status.as_ref();
            vec![
                coloured(st.and_then(|s| s.phase.clone()).unwrap_or_default(), status),
                plain(spec.and_then(|s| s.volume_name.clone()).unwrap_or_default()),
                plain(
                    st.and_then(|s| s.capacity.as_ref())
                        .and_then(|c| c.get("storage"))
                        .map(|q| q.0.clone())
                        .or_else(|| {
                            spec.and_then(|s| s.resources.as_ref())
                                .and_then(|r| r.requests.as_ref())
                                .and_then(|r| r.get("storage"))
                                .map(|q| q.0.clone())
                        })
                        .unwrap_or_default(),
                ),
                plain(join(spec.and_then(|s| s.access_modes.as_ref()))),
                plain(spec.and_then(|s| s.storage_class_name.clone()).unwrap_or_default()),
                age_cell,
            ]
        }
        Object::PersistentVolume(p) => {
            let spec = p.spec.as_ref();
            vec![
                plain(
                    spec.and_then(|s| s.capacity.as_ref())
                        .and_then(|c| c.get("storage"))
                        .map(|q| q.0.clone())
                        .unwrap_or_default(),
                ),
                plain(join(spec.and_then(|s| s.access_modes.as_ref()))),
                plain(spec.and_then(|s| s.persistent_volume_reclaim_policy.clone()).unwrap_or_default()),
                plain(p.status.as_ref().and_then(|s| s.phase.clone()).unwrap_or_default()),
                plain(
                    spec.and_then(|s| s.claim_ref.as_ref())
                        .map(|c| format!("{}/{}", c.namespace.clone().unwrap_or_default(), c.name.clone().unwrap_or_default()))
                        .unwrap_or_default(),
                ),
                plain(spec.and_then(|s| s.storage_class_name.clone()).unwrap_or_default()),
                age_cell,
            ]
        }
        Object::NetworkPolicy(np) => {
            let spec = np.spec.as_ref();
            vec![
                // An absent podSelector behaves like an empty one: it selects every pod.
                plain(crate::graph::selector::selector_text(
                    spec.and_then(|s| s.pod_selector.as_ref()).unwrap_or(&Default::default()),
                )),
                plain(
                    spec.map(|s| crate::graph::relations::policy_types(s).join(", "))
                        .unwrap_or_default(),
                ),
                age_cell,
            ]
        }
        Object::Role(r) => vec![plain(r.rules.as_ref().map_or(0, |v| v.len()).to_string()), age_cell],
        Object::ClusterRole(r) => vec![plain(r.rules.as_ref().map_or(0, |v| v.len()).to_string()), age_cell],
        Object::RoleBinding(b) => vec![
            plain(format!("{}/{}", b.role_ref.kind, b.role_ref.name)),
            plain(subjects_text(b.subjects.as_deref().unwrap_or_default())),
            age_cell,
        ],
        Object::ClusterRoleBinding(b) => vec![
            plain(format!("{}/{}", b.role_ref.kind, b.role_ref.name)),
            plain(subjects_text(b.subjects.as_deref().unwrap_or_default())),
            age_cell,
        ],
        Object::Node(n) => {
            let pods = node_pods.get(obj.name()).copied().unwrap_or(0);
            vec![
                coloured(node_status_text(n), status),
                plain(node_roles(n)),
                plain(
                    n.status
                        .as_ref()
                        .and_then(|s| s.node_info.as_ref())
                        .map(|i| i.kubelet_version.clone())
                        .unwrap_or_default(),
                ),
                plain(pods.to_string()),
                age_cell,
            ]
        }
        Object::ServiceAccount(_) => vec![age_cell],
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::store::{Kind, Store};

    fn now() -> jiff::Timestamp {
        "2026-09-17T12:00:00Z".parse().unwrap()
    }

    fn cell<'a>(t: &'a Table, name: &str, col: &str) -> &'a TableCell {
        let ci = t.columns.iter().position(|c| c.key == col).expect("column");
        let row = t.rows.iter().find(|r| r.cells[0].text == name).expect("row");
        &row.cells[ci]
    }

    #[test]
    fn usage_columns_for_pods_and_workloads() {
        let s = crate::metrics::usage::tests::sampled();
        for kind in [Kind::Pod, Kind::Deployment, Kind::StatefulSet, Kind::DaemonSet] {
            let keys: Vec<String> = columns(kind).into_iter().map(|c| c.key).collect();
            assert!(
                keys.contains(&"cpu".to_string()) && keys.contains(&"memory".to_string()),
                "{kind:?}: {keys:?}"
            );
            assert!(columns(kind)
                .iter()
                .filter(|c| c.key == "cpu" || c.key == "memory")
                .all(|c| c.numeric));
        }
        let pods = table(&s, Kind::Pod, now());
        assert_eq!(cell(&pods, "hot", "cpu").text, "300m");
        assert_eq!(cell(&pods, "hot", "memory").text, "92Mi");
        assert_eq!(cell(&pods, "unsampled", "cpu").text, "—");
        let deployments = table(&s, Kind::Deployment, now());
        assert_eq!(cell(&deployments, "api", "cpu").text, "200m");
        assert_eq!(cell(&deployments, "api", "memory").text, "100Mi");
        let statefulsets = table(&s, Kind::StatefulSet, now());
        assert_eq!(cell(&statefulsets, "db", "memory").text, "128Mi");
        let pending = Store::from_fixture("metrics").unwrap();
        assert_eq!(cell(&table(&pending, Kind::Pod, now()), "hot", "cpu").text, "—");
    }

    #[test]
    fn age_formats_like_kubectl() {
        let n = now();
        let at = |s: &str| Some(k8s_openapi::apimachinery::pkg::apis::meta::v1::Time(s.parse().unwrap()));
        assert_eq!(age(at("2026-09-17T11:59:15Z").as_ref(), n), "45s");
        assert_eq!(age(at("2026-09-17T11:48:00Z").as_ref(), n), "12m");
        assert_eq!(age(at("2026-09-17T09:00:00Z").as_ref(), n), "3h");
        assert_eq!(age(at("2026-09-13T12:00:00Z").as_ref(), n), "4d");
        assert_eq!(age(None, n), "—");
    }

    #[test]
    fn pod_table_has_kubectl_columns_and_statuses() {
        let s = Store::from_fixture("statuses").unwrap();
        let t = table(&s, Kind::Pod, now());
        assert_eq!(t.kind, Kind::Pod);
        assert_eq!(
            t.columns.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(),
            ["name", "ready", "status", "restarts", "cpu", "memory", "age", "node", "ip"]
        );
        assert_eq!(cell(&t, "crashing", "status").text, "CrashLoopBackOff");
        assert_eq!(cell(&t, "crashing", "status").status, Some(Status::Err));
        assert_eq!(cell(&t, "crashing", "restarts").text, "14");
        assert_eq!(cell(&t, "notready", "ready").text, "1/2");
        assert_eq!(cell(&t, "running", "ready").text, "1/1");
        let names: Vec<&str> = t.rows.iter().map(|r| r.cells[0].text.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "rows sorted by name");
        assert!(t.rows.iter().all(|r| r.node_id.starts_with("Pod/s/")));
    }

    #[test]
    fn deployment_service_pvc_columns() {
        let s = Store::from_fixture("statuses").unwrap();
        let d = table(&s, Kind::Deployment, now());
        assert_eq!(cell(&d, "rolling", "ready").text, "2/3");
        assert_eq!(cell(&d, "rolling", "ready").status, Some(Status::Warn));
        assert_eq!(cell(&d, "healthy", "images").text, "nginx:1.27");
        let svc = table(&s, Kind::Service, now());
        assert_eq!(cell(&svc, "matched", "ports").text, "80/TCP");
        assert_eq!(cell(&svc, "orphan", "type").text, "NodePort");
        let pvc = table(&s, Kind::PersistentVolumeClaim, now());
        assert_eq!(cell(&pvc, "waiting", "status").status, Some(Status::Warn));
        assert_eq!(cell(&pvc, "data", "capacity").text, "10Gi");
        let cj = table(&s, Kind::CronJob, now());
        assert_eq!(cell(&cj, "nightly", "suspend").text, "true");
    }

    #[test]
    fn every_kind_has_name_first_and_aligned_cells() {
        let s = Store::from_fixture("statuses").unwrap();
        for kind in Kind::WATCHED {
            let t = table(&s, kind, now());
            assert_eq!(t.columns[0].key, "name", "{kind:?}");
            for r in &t.rows {
                assert_eq!(r.cells.len(), t.columns.len(), "{kind:?}");
            }
        }
    }

    #[test]
    fn pod_group_and_empty_kinds_yield_empty_tables() {
        let s = Store::default();
        assert!(table(&s, Kind::Pod, now()).rows.is_empty());
        assert!(table(&s, Kind::PodGroup, now()).rows.is_empty());
    }

    #[test]
    fn a_namespace_column_leads_and_rows_sort_by_namespace_then_name() {
        let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: z, namespace: a }\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: b, namespace: b }\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: a, namespace: b }\n";
        let store = Store::from_yaml_docs(yaml).unwrap();
        let t = with_namespace_column(table(&store, Kind::ConfigMap, jiff::Timestamp::now()));
        assert_eq!(t.columns[0].key, "namespace");
        assert_eq!(t.columns[1].key, "name");
        let rows: Vec<(String, String)> = t.rows.iter().map(|r| (r.cells[0].text.clone(), r.cells[1].text.clone())).collect();
        assert_eq!(
            rows,
            vec![("a".into(), "z".into()), ("b".into(), "a".into()), ("b".into(), "b".into())]
        );
        let pv = Store::from_yaml_docs("apiVersion: v1\nkind: PersistentVolume\nmetadata: { name: pv-1 }\n").unwrap();
        let t = with_namespace_column(table(&pv, Kind::PersistentVolume, jiff::Timestamp::now()));
        assert_eq!(t.rows[0].cells[0].text, "—");
    }

    pub(crate) const POLICY_TYPES: &str = "apiVersion: v1
kind: Pod
metadata: { name: web-1, namespace: s, labels: { app: web } }
---
apiVersion: v1
kind: Pod
metadata: { name: client-1, namespace: s, labels: { app: client } }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: implicit-egress, namespace: s }
spec:
  podSelector: { matchLabels: { app: web } }
  ingress: [ { from: [ { podSelector: { matchLabels: { app: client } } } ] } ]
  egress: [ { to: [ { podSelector: { matchLabels: { app: client } } } ] } ]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: implicit-ingress, namespace: s }
spec:
  podSelector: { matchLabels: { app: web } }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: egress-only, namespace: s }
spec:
  podSelector: { matchLabels: { app: web } }
  policyTypes: [ Egress ]
  ingress: [ { from: [ { podSelector: { matchLabels: { app: client } } } ] } ]
";

    #[test]
    fn unset_policy_types_follow_kubernetes_defaults() {
        let s = Store::from_yaml_docs(POLICY_TYPES).unwrap();
        let t = table(&s, Kind::NetworkPolicy, now());
        assert_eq!(cell(&t, "implicit-egress", "policyTypes").text, "Ingress, Egress");
        assert_eq!(cell(&t, "implicit-ingress", "policyTypes").text, "Ingress");
        assert_eq!(cell(&t, "egress-only", "policyTypes").text, "Egress");
    }

    #[test]
    fn the_new_kinds_have_kubectl_columns() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let nodes = table(&s, Kind::Node, now());
        assert_eq!(cell(&nodes, "node-a", "status").text, "Ready");
        assert_eq!(cell(&nodes, "node-a", "roles").text, "control-plane");
        assert_eq!(cell(&nodes, "node-a", "version").text, "v1.36.1");
        assert_eq!(cell(&nodes, "node-a", "pods").text, "2");
        assert_eq!(cell(&nodes, "node-b", "status").text, "NotReady");
        assert_eq!(cell(&nodes, "node-c", "roles").text, "<none>");
        assert_eq!(cell(&nodes, "node-d", "status").text, "Ready,SchedulingDisabled");
        let policies = table(&s, Kind::NetworkPolicy, now());
        assert_eq!(cell(&policies, "web-ingress", "podSelector").text, "app=web");
        assert_eq!(cell(&policies, "deny-all", "podSelector").text, "all pods");
        assert_eq!(cell(&policies, "web-ingress", "policyTypes").text, "Ingress");
        assert_eq!(cell(&table(&s, Kind::Role, now()), "reader", "rules").text, "2");
        let bindings = table(&s, Kind::RoleBinding, now());
        assert_eq!(cell(&bindings, "web-reader", "role").text, "Role/reader");
        assert_eq!(cell(&bindings, "web-reader", "subjects").text, "ServiceAccount s/web, User alice");
        assert_eq!(
            cell(&table(&s, Kind::ClusterRoleBinding, now()), "web-cluster", "role").text,
            "ClusterRole/view"
        );
    }
}
