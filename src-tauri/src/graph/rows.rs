//! kubectl-like tables per kind, computed from the Store.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use k8s_openapi::jiff;
use serde::{Deserialize, Serialize};

use super::model::{node_id, NodeId, Status};
use super::status::describe;
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
    match kind {
        Kind::Pod => vec![
            name(),
            col("ready", "Ready", false),
            col("status", "Status", false),
            col("restarts", "Restarts", true),
            age_c(),
            col("node", "Node", false),
            col("ip", "IP", false),
        ],
        Kind::Deployment => vec![
            name(),
            col("ready", "Ready", false),
            col("upToDate", "Up-to-date", true),
            col("available", "Available", true),
            age_c(),
            col("images", "Images", false),
        ],
        Kind::StatefulSet => vec![name(), col("ready", "Ready", false), age_c(), col("images", "Images", false)],
        Kind::DaemonSet => vec![
            name(),
            col("desired", "Desired", true),
            col("ready", "Ready", true),
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
        Kind::PodGroup => vec![],
    }
}

/// Build the table for `kind` from the store. Rows sorted by name.
pub fn table(store: &Store, kind: Kind, now: jiff::Timestamp) -> Table {
    let columns = columns(kind);
    let mut rows: Vec<TableRow> = store
        .iter_kind(kind)
        .map(|obj| {
            let (status, badges) = describe(obj, store);
            let mut cells = vec![plain(obj.name())];
            cells.extend(kind_cells(obj, &badges, status, now));
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

fn kind_cells(obj: &Object, badges: &[String], status: Status, now: jiff::Timestamp) -> Vec<TableCell> {
    let created = obj.meta().creation_timestamp.as_ref();
    let age_cell = plain(age(created, now));
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
        Object::ServiceAccount(_) => vec![age_cell],
    }
}

#[cfg(test)]
mod tests {
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
            ["name", "ready", "status", "restarts", "age", "node", "ip"]
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
}
