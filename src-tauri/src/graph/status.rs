//! Status colour, badges and Overview rows for every supported kind.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{PersistentVolume, PersistentVolumeClaim, Pod, Service};
use k8s_openapi::api::networking::v1::Ingress;

use super::model::Status;
use crate::store::{Object, Store};

pub type Badges = Vec<String>;
pub type SummaryRows = Vec<(String, String)>;

/// Status + badges shown on the node card.
pub fn describe(obj: &Object, store: &Store) -> (Status, Badges) {
    match obj {
        Object::Deployment(d) => deployment(d),
        Object::StatefulSet(s) => statefulset(s),
        Object::DaemonSet(d) => daemonset(d),
        Object::ReplicaSet(r) => replicaset(r),
        Object::Job(j) => job(j),
        Object::CronJob(c) => cronjob(c),
        Object::Pod(p) => pod(p),
        Object::Service(s) => service(s, store),
        Object::Ingress(i) => ingress(i),
        Object::ConfigMap(c) => (
            Status::Ok,
            vec![keys_badge(
                c.data.as_ref().map_or(0, |d| d.len()) + c.binary_data.as_ref().map_or(0, |d| d.len()),
            )],
        ),
        Object::Secret(s) => (
            Status::Ok,
            vec![keys_badge(
                s.data.as_ref().map_or(0, |d| d.len()) + s.string_data.as_ref().map_or(0, |d| d.len()),
            )],
        ),
        Object::PersistentVolumeClaim(p) => pvc(p),
        Object::PersistentVolume(p) => pv(p),
        Object::ServiceAccount(_) => (Status::Ok, vec![]),
        Object::HorizontalPodAutoscaler(h) => hpa(h),
    }
}

fn keys_badge(n: usize) -> String {
    format!("{n} keys")
}

fn ready_desired(ready: i32, desired: i32) -> String {
    format!("{ready}/{desired}")
}

fn first_image(containers: &[k8s_openapi::api::core::v1::Container]) -> Option<String> {
    containers.first().and_then(|c| c.image.clone())
}

fn condition_is<'a>(conds: impl IntoIterator<Item = (&'a str, &'a str)>, ty: &str, status: &str) -> bool {
    conds.into_iter().any(|(t, s)| t == ty && s == status)
}

fn workload_status(ready: i32, desired: i32, progressing_false: bool) -> Status {
    if ready < desired && progressing_false {
        Status::Err
    } else if ready < desired {
        Status::Warn
    } else {
        Status::Ok
    }
}

fn deployment(d: &Deployment) -> (Status, Badges) {
    let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let st = d.status.as_ref();
    let ready = st.and_then(|s| s.ready_replicas).unwrap_or(0);
    let progressing_false = st
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| condition_is(cs.iter().map(|c| (c.type_.as_str(), c.status.as_str())), "Progressing", "False"))
        .unwrap_or(false);
    let mut badges = vec![ready_desired(ready, desired)];
    if let Some(img) = d
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| first_image(&ps.containers))
    {
        badges.push(img);
    }
    (workload_status(ready, desired, progressing_false), badges)
}

fn statefulset(s: &StatefulSet) -> (Status, Badges) {
    let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let ready = s.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
    let mut badges = vec![ready_desired(ready, desired)];
    if let Some(img) = s
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| first_image(&ps.containers))
    {
        badges.push(img);
    }
    (workload_status(ready, desired, false), badges)
}

fn daemonset(d: &DaemonSet) -> (Status, Badges) {
    let st = d.status.as_ref();
    let desired = st.map(|s| s.desired_number_scheduled).unwrap_or(0);
    let ready = st.map(|s| s.number_ready).unwrap_or(0);
    let mut badges = vec![ready_desired(ready, desired)];
    if let Some(img) = d
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| first_image(&ps.containers))
    {
        badges.push(img);
    }
    (workload_status(ready, desired, false), badges)
}

fn replicaset(r: &ReplicaSet) -> (Status, Badges) {
    let desired = r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let ready = r.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
    (workload_status(ready, desired, false), vec![ready_desired(ready, desired)])
}

fn job(j: &Job) -> (Status, Badges) {
    let completions = j.spec.as_ref().and_then(|s| s.completions).unwrap_or(1);
    let st = j.status.as_ref();
    let succeeded = st.and_then(|s| s.succeeded).unwrap_or(0);
    let failed = st
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| condition_is(cs.iter().map(|c| (c.type_.as_str(), c.status.as_str())), "Failed", "True"))
        .unwrap_or(false);
    // Spec §5.1: err if condition `Failed=True`. A Job still running toward its
    // completion count (succeeded < completions, not failed) is `Ok`, not a warning.
    let status = if failed { Status::Err } else { Status::Ok };
    (status, vec![ready_desired(succeeded, completions)])
}

fn cronjob(c: &CronJob) -> (Status, Badges) {
    let schedule = c.spec.schedule.clone();
    let suspended = c.spec.suspend.unwrap_or(false);
    (if suspended { Status::Warn } else { Status::Ok }, vec![schedule])
}

const POD_ERR_REASONS: [&str; 5] = ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled", "Error"];

fn pod(p: &Pod) -> (Status, Badges) {
    let st = p.status.as_ref();
    let phase = st.and_then(|s| s.phase.clone()).unwrap_or_else(|| "Unknown".into());
    let statuses = st.and_then(|s| s.container_statuses.as_ref()).cloned().unwrap_or_default();
    let restarts: i32 = statuses.iter().map(|c| c.restart_count).sum();

    // A container that has legitimately finished (e.g. an init-like sidecar) is permanently
    // `ready: false` but should not count against the pod's readiness.
    let is_completed = |c: &k8s_openapi::api::core::v1::ContainerStatus| {
        c.state
            .as_ref()
            .and_then(|s| s.terminated.as_ref())
            .and_then(|t| t.reason.as_deref())
            == Some("Completed")
    };
    let all_ready = !statuses.is_empty() && statuses.iter().all(|c| c.ready || is_completed(c));

    // A waiting/terminated reason is more informative than the phase.
    let reason = statuses.iter().find_map(|c| {
        let state = c.state.as_ref()?;
        state.waiting.as_ref().and_then(|w| w.reason.clone()).or_else(|| {
            state
                .terminated
                .as_ref()
                .and_then(|t| t.reason.clone())
                .filter(|r| r != "Completed")
        })
    });

    let is_err = phase == "Failed" || reason.as_deref().is_some_and(|r| POD_ERR_REASONS.contains(&r));
    // A pod being deleted (graceful termination in progress) is a warning, not the plain
    // phase/reason label — but an err reason (e.g. still crashing while terminating) wins.
    let terminating = p.metadata.deletion_timestamp.is_some();
    let label = if terminating && !is_err {
        "Terminating".to_string()
    } else {
        reason.clone().unwrap_or_else(|| phase.clone())
    };
    let status = if is_err {
        Status::Err
    } else if terminating {
        Status::Warn
    } else if phase == "Succeeded" {
        Status::Ok
    } else if phase == "Pending" || phase == "Unknown" || !all_ready {
        Status::Warn
    } else {
        Status::Ok
    };

    let mut badges = vec![label];
    if restarts > 0 {
        badges.push(format!("↻ {restarts}"));
    }
    (status, badges)
}

/// True when every key/value of `selector` is present in `labels`. An empty selector matches nothing.
pub fn selector_matches(selector: &BTreeMap<String, String>, labels: Option<&BTreeMap<String, String>>) -> bool {
    if selector.is_empty() {
        return false;
    }
    let Some(labels) = labels else { return false };
    selector.iter().all(|(k, v)| labels.get(k) == Some(v))
}

fn service(s: &Service, store: &Store) -> (Status, Badges) {
    let spec = s.spec.as_ref();
    let ty = spec.and_then(|s| s.type_.clone()).unwrap_or_else(|| "ClusterIP".into());
    let mut badges = vec![ty];
    if let Some(port) = spec.and_then(|s| s.ports.as_ref()).and_then(|p| p.first()) {
        let target = match &port.target_port {
            Some(k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i)) => i.to_string(),
            Some(k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s)) => s.clone(),
            None => port.port.to_string(),
        };
        badges.push(format!("{}→{}", port.port, target));
    }
    let status = match spec.and_then(|s| s.selector.as_ref()) {
        // Headless/ExternalName services without a selector are not "orphans".
        None => Status::Ok,
        Some(sel) => {
            let ns = s.metadata.namespace.as_deref();
            let any = store
                .iter_kind(crate::store::Kind::Pod)
                .filter(|p| p.namespace() == ns)
                .any(|p| selector_matches(sel, p.meta().labels.as_ref()));
            if any {
                Status::Ok
            } else {
                Status::Warn
            }
        }
    };
    (status, badges)
}

fn ingress(i: &Ingress) -> (Status, Badges) {
    let hosts: Vec<String> = i
        .spec
        .as_ref()
        .and_then(|s| s.rules.as_ref())
        .map(|rules| rules.iter().filter_map(|r| r.host.clone()).collect())
        .unwrap_or_default();
    let badge = match hosts.len() {
        0 => None,
        1 => Some(hosts[0].clone()),
        n => Some(format!("{} +{}", hosts[0], n - 1)),
    };
    (Status::Ok, badge.into_iter().collect())
}

fn pvc(p: &PersistentVolumeClaim) -> (Status, Badges) {
    let spec = p.spec.as_ref();
    let mut badges = vec![];
    if let Some(size) = spec
        .and_then(|s| s.resources.as_ref())
        .and_then(|r| r.requests.as_ref())
        .and_then(|r| r.get("storage"))
    {
        badges.push(size.0.clone());
    }
    if let Some(sc) = spec.and_then(|s| s.storage_class_name.clone()) {
        badges.push(sc);
    }
    let pending = p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Pending");
    (if pending { Status::Warn } else { Status::Ok }, badges)
}

fn pv(p: &PersistentVolume) -> (Status, Badges) {
    let spec = p.spec.as_ref();
    let mut badges = vec![];
    if let Some(cap) = spec.and_then(|s| s.capacity.as_ref()).and_then(|c| c.get("storage")) {
        badges.push(cap.0.clone());
    }
    if let Some(policy) = spec.and_then(|s| s.persistent_volume_reclaim_policy.clone()) {
        badges.push(policy);
    }
    (Status::Ok, badges)
}

fn hpa(h: &HorizontalPodAutoscaler) -> (Status, Badges) {
    let spec = &h.spec;
    let min = spec.min_replicas.unwrap_or(1);
    let max = spec.max_replicas;
    let st = h.status.as_ref();
    let current = st.and_then(|s| s.current_replicas).unwrap_or(0);
    let limited = st
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| condition_is(cs.iter().map(|c| (c.type_.as_str(), c.status.as_str())), "ScalingLimited", "True"))
        .unwrap_or(false);
    (
        if limited { Status::Warn } else { Status::Ok },
        vec![format!("{min}–{max}"), current.to_string()],
    )
}

fn labels_string(labels: Option<&BTreeMap<String, String>>) -> String {
    labels
        .map(|l| l.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", "))
        .unwrap_or_default()
}

/// Key/value rows for the Overview tab.
pub fn summary(obj: &Object) -> SummaryRows {
    let mut rows: SummaryRows = vec![
        ("Name".into(), obj.name().into()),
        ("Namespace".into(), obj.namespace().unwrap_or("—").into()),
        ("Kind".into(), obj.kind().as_str().into()),
    ];
    if let Some(ts) = &obj.meta().creation_timestamp {
        rows.push(("Created".into(), ts.0.to_string()));
    }
    let labels = labels_string(obj.meta().labels.as_ref());
    if !labels.is_empty() {
        rows.push(("Labels".into(), labels));
    }
    match obj {
        Object::Pod(p) => {
            let st = p.status.as_ref();
            rows.push(("Phase".into(), st.and_then(|s| s.phase.clone()).unwrap_or_default()));
            rows.push(("Node".into(), p.spec.as_ref().and_then(|s| s.node_name.clone()).unwrap_or_default()));
            rows.push(("Pod IP".into(), st.and_then(|s| s.pod_ip.clone()).unwrap_or_default()));
            let statuses = st.and_then(|s| s.container_statuses.as_ref()).cloned().unwrap_or_default();
            rows.push(("Restarts".into(), statuses.iter().map(|c| c.restart_count).sum::<i32>().to_string()));
            for c in p.spec.as_ref().map(|s| s.containers.as_slice()).unwrap_or_default() {
                rows.push((format!("Container {}", c.name), c.image.clone().unwrap_or_default()));
            }
        }
        Object::Service(s) => {
            let spec = s.spec.as_ref();
            rows.push(("Type".into(), spec.and_then(|s| s.type_.clone()).unwrap_or_default()));
            rows.push(("Cluster IP".into(), spec.and_then(|s| s.cluster_ip.clone()).unwrap_or_default()));
            rows.push(("Selector".into(), labels_string(spec.and_then(|s| s.selector.as_ref()))));
            let ports = spec
                .and_then(|s| s.ports.as_ref())
                .map(|ps| {
                    ps.iter()
                        .map(|p| format!("{}/{}", p.port, p.protocol.clone().unwrap_or_else(|| "TCP".into())))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            rows.push(("Ports".into(), ports));
        }
        Object::Deployment(d) => {
            let st = d.status.as_ref();
            rows.push((
                "Replicas".into(),
                format!(
                    "{} desired / {} ready / {} available",
                    d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1),
                    st.and_then(|s| s.ready_replicas).unwrap_or(0),
                    st.and_then(|s| s.available_replicas).unwrap_or(0)
                ),
            ));
            rows.push((
                "Strategy".into(),
                d.spec
                    .as_ref()
                    .and_then(|s| s.strategy.as_ref())
                    .and_then(|s| s.type_.clone())
                    .unwrap_or_default(),
            ));
            if let Some(cs) = st.and_then(|s| s.conditions.as_ref()) {
                rows.extend(cs.iter().map(|c| {
                    (
                        format!("Condition {}", c.type_),
                        format!("{} {}", c.status, c.reason.clone().unwrap_or_default()),
                    )
                }));
            }
        }
        Object::Ingress(i) => {
            rows.push((
                "Class".into(),
                i.spec.as_ref().and_then(|s| s.ingress_class_name.clone()).unwrap_or_default(),
            ));
            for r in i
                .spec
                .as_ref()
                .and_then(|s| s.rules.as_ref())
                .map(|r| r.as_slice())
                .unwrap_or_default()
            {
                let backends = r
                    .http
                    .as_ref()
                    .map(|h| {
                        h.paths
                            .iter()
                            .map(|p| {
                                format!(
                                    "{} → {}",
                                    p.path.clone().unwrap_or_else(|| "/".into()),
                                    p.backend.service.as_ref().map(|s| s.name.clone()).unwrap_or_default()
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("; ")
                    })
                    .unwrap_or_default();
                rows.push((format!("Host {}", r.host.clone().unwrap_or_else(|| "*".into())), backends));
            }
        }
        Object::PersistentVolumeClaim(p) => {
            rows.push(("Phase".into(), p.status.as_ref().and_then(|s| s.phase.clone()).unwrap_or_default()));
            rows.push((
                "Volume".into(),
                p.spec.as_ref().and_then(|s| s.volume_name.clone()).unwrap_or_default(),
            ));
        }
        Object::HorizontalPodAutoscaler(h) => {
            if let Some(cs) = h.status.as_ref().and_then(|s| s.conditions.as_ref()) {
                rows.extend(cs.iter().map(|c| {
                    (
                        format!("Condition {}", c.type_),
                        format!("{} {}", c.status, c.reason.clone().unwrap_or_default()),
                    )
                }));
            }
        }
        Object::Job(j) => {
            if let Some(cs) = j.status.as_ref().and_then(|s| s.conditions.as_ref()) {
                rows.extend(cs.iter().map(|c| {
                    (
                        format!("Condition {}", c.type_),
                        format!("{} {}", c.status, c.reason.clone().unwrap_or_default()),
                    )
                }));
            }
        }
        _ => {}
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Kind, Store};

    fn describe_named(store: &Store, kind: Kind, name: &str) -> (Status, Vec<String>) {
        let obj = store.find(kind, Some("s"), name).or_else(|| store.find(kind, None, name)).unwrap();
        describe(obj, store)
    }

    #[test]
    fn deployment_statuses() {
        let s = Store::from_fixture("statuses").unwrap();
        assert_eq!(
            describe_named(&s, Kind::Deployment, "healthy"),
            (Status::Ok, vec!["3/3".into(), "nginx:1.27".into()])
        );
        assert_eq!(describe_named(&s, Kind::Deployment, "rolling").0, Status::Warn);
        assert_eq!(describe_named(&s, Kind::Deployment, "stuck").0, Status::Err);
        assert_eq!(
            describe_named(&s, Kind::StatefulSet, "db"),
            (Status::Ok, vec!["3/3".into(), "postgres:16".into()])
        );
        assert_eq!(
            describe_named(&s, Kind::DaemonSet, "agent"),
            (Status::Warn, vec!["3/4".into(), "agent:2".into()])
        );
    }

    #[test]
    fn pod_statuses() {
        let s = Store::from_fixture("statuses").unwrap();
        assert_eq!(describe_named(&s, Kind::Pod, "running"), (Status::Ok, vec!["Running".into()]));
        assert_eq!(
            describe_named(&s, Kind::Pod, "crashing"),
            (Status::Err, vec!["CrashLoopBackOff".into(), "↻ 14".into()])
        );
        assert_eq!(describe_named(&s, Kind::Pod, "pending"), (Status::Warn, vec!["Pending".into()]));
        assert_eq!(
            describe_named(&s, Kind::Pod, "notready"),
            (Status::Warn, vec!["Running".into(), "↻ 2".into()])
        );
        assert_eq!(
            describe_named(&s, Kind::Pod, "oom"),
            (Status::Err, vec!["OOMKilled".into(), "↻ 3".into()])
        );
        assert_eq!(describe_named(&s, Kind::Pod, "sidecar-done"), (Status::Ok, vec!["Running".into()]));
        assert_eq!(
            describe_named(&s, Kind::Pod, "terminating"),
            (Status::Warn, vec!["Terminating".into()])
        );
    }

    #[test]
    fn service_warns_when_selector_matches_nothing() {
        let s = Store::from_fixture("statuses").unwrap();
        assert_eq!(
            describe_named(&s, Kind::Service, "matched"),
            (Status::Ok, vec!["ClusterIP".into(), "80→8080".into()])
        );
        assert_eq!(
            describe_named(&s, Kind::Service, "orphan"),
            (Status::Warn, vec!["NodePort".into(), "443→https".into()])
        );
    }

    #[test]
    fn config_storage_and_batch_badges() {
        let s = Store::from_fixture("statuses").unwrap();
        assert_eq!(
            describe_named(&s, Kind::Ingress, "multi"),
            (Status::Ok, vec!["a.example.com +1".into()])
        );
        assert_eq!(describe_named(&s, Kind::ConfigMap, "cfg"), (Status::Ok, vec!["3 keys".into()]));
        assert_eq!(describe_named(&s, Kind::Secret, "tls"), (Status::Ok, vec!["2 keys".into()]));
        assert_eq!(
            describe_named(&s, Kind::PersistentVolumeClaim, "data"),
            (Status::Ok, vec!["10Gi".into(), "fast".into()])
        );
        assert_eq!(
            describe_named(&s, Kind::PersistentVolumeClaim, "waiting"),
            (Status::Warn, vec!["1Gi".into()])
        );
        assert_eq!(
            describe_named(&s, Kind::PersistentVolume, "pv-1"),
            (Status::Ok, vec!["10Gi".into(), "Retain".into()])
        );
        assert_eq!(describe_named(&s, Kind::Job, "ok-job"), (Status::Ok, vec!["2/2".into()]));
        assert_eq!(describe_named(&s, Kind::Job, "failed-job"), (Status::Err, vec!["0/1".into()]));
        assert_eq!(describe_named(&s, Kind::Job, "running-job"), (Status::Ok, vec!["1/3".into()]));
        assert_eq!(
            describe_named(&s, Kind::CronJob, "nightly"),
            (Status::Warn, vec!["0 2 * * *".into()])
        );
        assert_eq!(
            describe_named(&s, Kind::HorizontalPodAutoscaler, "web-hpa"),
            (Status::Warn, vec!["2–10".into(), "3".into()])
        );
        assert_eq!(describe_named(&s, Kind::ServiceAccount, "web-sa"), (Status::Ok, vec![]));
    }

    #[test]
    fn summary_has_kind_specific_rows() {
        let s = Store::from_fixture("statuses").unwrap();
        let pod = s.find(Kind::Pod, Some("s"), "crashing").unwrap();
        let rows = summary(pod);
        assert!(rows.iter().any(|(k, v)| k == "Phase" && v == "Running"));
        assert!(rows.iter().any(|(k, v)| k == "Restarts" && v == "14"));
        let svc = s.find(Kind::Service, Some("s"), "matched").unwrap();
        let rows = summary(svc);
        assert!(rows.iter().any(|(k, v)| k == "Selector" && v == "app=running"));
    }
}
