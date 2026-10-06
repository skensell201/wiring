//! Status colour, badges and Overview rows for every supported kind.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::{HorizontalPodAutoscaler, HorizontalPodAutoscalerCondition};
use k8s_openapi::api::batch::v1::{CronJob, Job, JobCondition};
use k8s_openapi::api::core::v1::{ContainerStatus, Node, NodeCondition, PersistentVolume, PersistentVolumeClaim, Pod, Service};
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicyPeer, NetworkPolicyPort};
use k8s_openapi::api::rbac::v1::PolicyRule;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;

use super::model::{Problem, Status};
use super::relations::ingress_backend_names;
use crate::metrics::usage::PodIndex;
use crate::store::{Kind, Object, Store};

pub type Badges = Vec<String>;
pub type SummaryRows = Vec<(String, String)>;

/// Status + badges shown on the node card. A pod or workload at >= 80 % of a limit gets its usage
/// badge last, so badges[0] (ready/desired, a pod's reason, an HPA's min-max) keeps its meaning.
pub fn describe(obj: &Object, store: &Store) -> (Status, Badges) {
    // A pod stands for itself; only a workload needs the index, so only it pays to build one.
    let index = if matches!(obj, Object::Pod(_)) {
        PodIndex::default()
    } else {
        PodIndex::new(store)
    };
    describe_with(obj, store, &index)
}

/// `describe` with a pod index shared by the caller, for loops over many objects.
pub fn describe_with<'a>(obj: &'a Object, store: &'a Store, index: &PodIndex<'a>) -> (Status, Badges) {
    let (status, mut badges) = base_describe(obj, store);
    if matches!(obj, Object::Pod(_)) && picked_by_a_policy(obj, store) {
        badges.push("policy".into());
    }
    if let Some(b) = crate::metrics::usage::usage_badge(store, index, obj) {
        badges.push(b);
    }
    (status, badges)
}

fn base_describe(obj: &Object, store: &Store) -> (Status, Badges) {
    match obj {
        Object::Deployment(d) => deployment(d),
        Object::StatefulSet(s) => statefulset(s),
        Object::DaemonSet(d) => daemonset(d),
        Object::ReplicaSet(r) => replicaset(r),
        Object::Job(j) => job(j),
        Object::CronJob(c) => cronjob(c),
        Object::Pod(p) => pod(p),
        Object::Service(s) => service(s, store),
        Object::Ingress(i) => ingress(i, store),
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
        Object::Node(n) => node(n),
        // Policies and RBAC objects are always ok.
        Object::NetworkPolicy(_) | Object::Role(_) | Object::RoleBinding(_) | Object::ClusterRole(_) | Object::ClusterRoleBinding(_) => {
            (Status::Ok, vec![])
        }
    }
}

/// Conditions that make a Ready node yellow.
const NODE_PRESSURE: [&str; 4] = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"];

fn node_conditions(n: &Node) -> &[NodeCondition] {
    n.status.as_ref().and_then(|s| s.conditions.as_deref()).unwrap_or_default()
}

fn node_pressure(n: &Node) -> Option<&NodeCondition> {
    node_conditions(n)
        .iter()
        .find(|c| NODE_PRESSURE.contains(&c.type_.as_str()) && c.status == "True")
}

/// Not ready -> err; a pressure condition -> warn. A node without a Ready condition (hand-written
/// fixtures) counts as ok.
fn node(n: &Node) -> (Status, Badges) {
    let not_ready = node_conditions(n).iter().any(|c| c.type_ == "Ready" && c.status != "True");
    let mut badges = vec![super::rows::node_ready_text(n)];
    if let Some(v) = n.status.as_ref().and_then(|s| s.node_info.as_ref()) {
        badges.push(v.kubelet_version.clone());
    }
    let pressure = node_pressure(n);
    if let Some(c) = pressure {
        badges.push(c.type_.clone());
    }
    let status = if not_ready {
        Status::Err
    } else if pressure.is_some() {
        Status::Warn
    } else {
        Status::Ok
    };
    (status, badges)
}

/// Whether a NetworkPolicy in the pod's namespace selects it (so its traffic is restricted).
fn picked_by_a_policy(pod: &Object, store: &Store) -> bool {
    store.iter_kind(Kind::NetworkPolicy).any(|np| {
        let Object::NetworkPolicy(np) = np else { return false };
        np.metadata.namespace.as_deref() == pod.namespace()
            && np.spec.as_ref().is_some_and(|s| {
                super::selector::label_selector_matches(&s.pod_selector.clone().unwrap_or_default(), pod.meta().labels.as_ref())
            })
    })
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

/// `rolling updated/desired` while a rollout runs: the controller has not observed the latest
/// generation, or fewer than `target` replicas run the new template yet. `target` is `None` when
/// the strategy never rolls on its own (paused, OnDelete). Missing fields (old servers,
/// hand-written fixtures) never count as rolling; a missing updated count shows no numbers.
fn rolling(generation: Option<i64>, observed: Option<i64>, updated: Option<i32>, target: Option<i32>, desired: i32) -> Option<String> {
    let unseen = matches!((generation, observed), (Some(g), Some(o)) if o < g);
    let behind = matches!((updated, target), (Some(u), Some(t)) if u < t);
    if !(unseen || behind) {
        return None;
    }
    Some(match updated {
        Some(u) => format!("rolling {u}/{desired}"),
        None => "rolling".to_string(),
    })
}

/// Push the rolling badge (if any) and lift an otherwise healthy workload to a warning.
fn with_rollout(status: Status, rolling: Option<String>, badges: &mut Badges) -> Status {
    let Some(badge) = rolling else { return status };
    badges.push(badge);
    if status == Status::Ok {
        Status::Warn
    } else {
        status
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
    let rollout = rolling(
        d.metadata.generation,
        st.and_then(|s| s.observed_generation),
        st.and_then(|s| s.updated_replicas),
        (!d.spec.as_ref().and_then(|s| s.paused).unwrap_or(false)).then_some(desired),
        desired,
    );
    let status = with_rollout(workload_status(ready, desired, progressing_false), rollout, &mut badges);
    if let Some(img) = d
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| first_image(&ps.containers))
    {
        badges.push(img);
    }
    (status, badges)
}

fn statefulset(s: &StatefulSet) -> (Status, Badges) {
    let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let st = s.status.as_ref();
    let ready = st.and_then(|s| s.ready_replicas).unwrap_or(0);
    let mut badges = vec![ready_desired(ready, desired)];
    // OnDelete never rolls on its own; a partition leaves the first `partition` pods on the old revision.
    let strategy = s.spec.as_ref().and_then(|s| s.update_strategy.as_ref());
    let partition = strategy
        .and_then(|u| u.rolling_update.as_ref())
        .and_then(|r| r.partition)
        .unwrap_or(0);
    let target = (strategy.and_then(|u| u.type_.as_deref()) != Some("OnDelete")).then(|| (desired - partition).max(0));
    let rollout = rolling(
        s.metadata.generation,
        st.and_then(|s| s.observed_generation),
        st.and_then(|s| s.updated_replicas),
        target,
        desired,
    );
    let status = with_rollout(workload_status(ready, desired, false), rollout, &mut badges);
    if let Some(img) = s
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| first_image(&ps.containers))
    {
        badges.push(img);
    }
    (status, badges)
}

fn daemonset(d: &DaemonSet) -> (Status, Badges) {
    let st = d.status.as_ref();
    let desired = st.map(|s| s.desired_number_scheduled).unwrap_or(0);
    let ready = st.map(|s| s.number_ready).unwrap_or(0);
    let mut badges = vec![ready_desired(ready, desired)];
    let rollout = rolling(
        d.metadata.generation,
        st.and_then(|s| s.observed_generation),
        st.and_then(|s| s.updated_number_scheduled),
        (d.spec
            .as_ref()
            .and_then(|s| s.update_strategy.as_ref())
            .and_then(|u| u.type_.as_deref())
            != Some("OnDelete"))
        .then_some(desired),
        desired,
    );
    let status = with_rollout(workload_status(ready, desired, false), rollout, &mut badges);
    if let Some(img) = d
        .spec
        .as_ref()
        .and_then(|s| s.template.spec.as_ref())
        .and_then(|ps| first_image(&ps.containers))
    {
        badges.push(img);
    }
    (status, badges)
}

fn replicaset(r: &ReplicaSet) -> (Status, Badges) {
    let desired = r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let ready = r.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
    (workload_status(ready, desired, false), vec![ready_desired(ready, desired)])
}

/// The `Failed=True` condition of a Job, if any.
fn failed_condition(j: &Job) -> Option<&JobCondition> {
    j.status
        .as_ref()?
        .conditions
        .as_deref()?
        .iter()
        .find(|c| c.type_ == "Failed" && c.status == "True")
}

fn job(j: &Job) -> (Status, Badges) {
    let completions = j.spec.as_ref().and_then(|s| s.completions).unwrap_or(1);
    let st = j.status.as_ref();
    let succeeded = st.and_then(|s| s.succeeded).unwrap_or(0);
    let failed = failed_condition(j).is_some();
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

/// A container that has legitimately finished (e.g. an init-like sidecar) is permanently
/// `ready: false` but should not count against the pod's readiness.
fn is_completed(c: &ContainerStatus) -> bool {
    c.state
        .as_ref()
        .and_then(|s| s.terminated.as_ref())
        .and_then(|t| t.reason.as_deref())
        == Some("Completed")
}

/// The first container with a waiting reason or a non-`Completed` terminated reason, the same
/// one the node badge shows.
fn container_reason(statuses: &[ContainerStatus]) -> Option<(&ContainerStatus, String)> {
    statuses.iter().find_map(|c| {
        let state = c.state.as_ref()?;
        let reason = state.waiting.as_ref().and_then(|w| w.reason.clone()).or_else(|| {
            state
                .terminated
                .as_ref()
                .and_then(|t| t.reason.clone())
                .filter(|r| r != "Completed")
        })?;
        Some((c, reason))
    })
}

const POD_ERR_REASONS: [&str; 5] = ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled", "Error"];

fn pod(p: &Pod) -> (Status, Badges) {
    let st = p.status.as_ref();
    let phase = st.and_then(|s| s.phase.clone()).unwrap_or_else(|| "Unknown".into());
    let statuses = st.and_then(|s| s.container_statuses.as_ref()).cloned().unwrap_or_default();
    let restarts: i32 = statuses.iter().map(|c| c.restart_count).sum();

    let all_ready = !statuses.is_empty() && statuses.iter().all(|c| c.ready || is_completed(c));

    // A waiting/terminated reason is more informative than the phase.
    let reason = container_reason(&statuses).map(|(_, r)| r);

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

/// Ready means a `Ready=True` condition, a phase of Running when one is known, and not being deleted;
/// a pod without a `Ready` condition or a phase counts as ready, so hand-written fixtures stay healthy.
pub(crate) fn pod_ready(p: &Pod) -> bool {
    let status = p.status.as_ref();
    p.metadata.deletion_timestamp.is_none()
        && status.and_then(|s| s.phase.as_deref()).is_none_or(|ph| ph == "Running")
        && status
            .and_then(|s| s.conditions.as_ref())
            .is_none_or(|cs| cs.iter().all(|c| c.type_ != "Ready" || c.status == "True"))
}

/// Pods a Service's selector matches and how many of them are ready; `None` without a selector
/// (headless/ExternalName services are not orphans).
fn selected_pods(s: &Service, store: &Store) -> Option<(usize, usize)> {
    let sel = s.spec.as_ref()?.selector.as_ref()?;
    let ns = s.metadata.namespace.as_deref();
    let (mut matched, mut ready) = (0, 0);
    for p in store.iter_kind(Kind::Pod).filter(|p| p.namespace() == ns) {
        if !selector_matches(sel, p.meta().labels.as_ref()) {
            continue;
        }
        matched += 1;
        if matches!(p, Object::Pod(pod) if pod_ready(pod)) {
            ready += 1;
        }
    }
    Some((matched, ready))
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
    let status = match selected_pods(s, store) {
        Some((_, 0)) => Status::Warn,
        _ => Status::Ok,
    };
    (status, badges)
}

fn ingress(i: &Ingress, store: &Store) -> (Status, Badges) {
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
    let missing = !missing_backends(i, store).is_empty();
    (if missing { Status::Warn } else { Status::Ok }, badge.into_iter().collect())
}

fn missing_backends(i: &Ingress, store: &Store) -> Vec<String> {
    ingress_backend_names(i)
        .into_iter()
        .filter(|name| store.find(Kind::Service, i.metadata.namespace.as_deref(), name).is_none())
        .collect()
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

/// The condition that makes an HPA yellow, most severe first: it cannot read metrics, cannot
/// scale, or is pinned at its min/max.
fn hpa_blocker(h: &HorizontalPodAutoscaler) -> Option<&HorizontalPodAutoscalerCondition> {
    let conds = h.status.as_ref()?.conditions.as_deref()?;
    [("ScalingActive", "False"), ("AbleToScale", "False"), ("ScalingLimited", "True")]
        .iter()
        .find_map(|(ty, st)| conds.iter().find(|c| c.type_ == *ty && c.status == *st))
}

fn hpa(h: &HorizontalPodAutoscaler) -> (Status, Badges) {
    let spec = &h.spec;
    let min = spec.min_replicas.unwrap_or(1);
    let max = spec.max_replicas;
    let st = h.status.as_ref();
    let current = st.and_then(|s| s.current_replicas).unwrap_or(0);
    let limited = hpa_blocker(h).is_some();
    (
        if limited { Status::Warn } else { Status::Ok },
        vec![format!("{min}–{max}"), current.to_string()],
    )
}

const MESSAGE_LIMIT: usize = 300;

/// A problem with no cause yet (`graph::build` links causes); the message is trimmed.
fn own(reason: impl Into<String>, message: Option<String>) -> Problem {
    let message = message.map(|m| {
        if m.chars().count() <= MESSAGE_LIMIT {
            m
        } else {
            let mut t: String = m.chars().take(MESSAGE_LIMIT - 1).collect();
            t.push('…');
            t
        }
    });
    Problem {
        reason: reason.into(),
        message,
        cause: None,
    }
}

/// Why `obj` is yellow or red, from its own status fields; `None` for healthy objects.
pub fn problem(obj: &Object, status: Status, store: &Store) -> Option<Problem> {
    if status < Status::Warn {
        return None;
    }
    Some(match obj {
        Object::Pod(p) => pod_problem(p),
        Object::Deployment(d) => deployment_problem(d),
        Object::StatefulSet(s) => {
            let desired = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            not_ready(s.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0), desired)
        }
        Object::DaemonSet(d) => {
            let st = d.status.as_ref();
            not_ready(
                st.map(|s| s.number_ready).unwrap_or(0),
                st.map(|s| s.desired_number_scheduled).unwrap_or(0),
            )
        }
        Object::ReplicaSet(r) => {
            let desired = r.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            not_ready(r.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0), desired)
        }
        Object::Job(j) => match failed_condition(j) {
            Some(c) => own(c.reason.clone().unwrap_or_else(|| "Failed".into()), c.message.clone()),
            None => own("Failed", None),
        },
        Object::CronJob(_) => own("Suspended", None),
        Object::Service(s) => match selected_pods(s, store) {
            Some((0, _)) => own("Selects no pods", None),
            _ => own("No ready endpoints", None),
        },
        Object::Ingress(i) => {
            let missing = missing_backends(i, store);
            debug_assert!(!missing.is_empty());
            let message = match missing.as_slice() {
                [one] => format!("service \"{one}\" does not exist"),
                many => format!(
                    "services {} do not exist",
                    many.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(", ")
                ),
            };
            own("Backend not found", Some(message))
        }
        Object::PersistentVolumeClaim(_) => own("Pending", None),
        Object::HorizontalPodAutoscaler(h) => match hpa_blocker(h) {
            Some(c) => own(c.reason.clone().unwrap_or_else(|| c.type_.clone()), c.message.clone()),
            None => own("ScalingLimited", None),
        },
        Object::Node(n) => match node_conditions(n).iter().find(|c| c.type_ == "Ready" && c.status != "True") {
            Some(c) => own("NotReady", c.message.clone()),
            None => {
                let c = node_pressure(n)?;
                own(c.type_.clone(), c.message.clone())
            }
        },
        _ => return None,
    })
}

/// `N of M not ready`, or `Rolling out` for a workload that is yellow only because a rollout runs.
fn not_ready(ready: i32, desired: i32) -> Problem {
    if ready < desired {
        own(format!("{} of {desired} not ready", desired - ready), None)
    } else {
        own("Rolling out", None)
    }
}

fn deployment_problem(d: &Deployment) -> Problem {
    let conds = d.status.as_ref().and_then(|s| s.conditions.as_deref()).unwrap_or_default();
    let failing = conds
        .iter()
        .find(|c| c.type_ == "Progressing" && c.status == "False")
        .or_else(|| conds.iter().find(|c| c.type_ == "ReplicaFailure" && c.status == "True"));
    if let Some(c) = failing {
        return own(c.reason.clone().unwrap_or_else(|| c.type_.clone()), c.message.clone());
    }
    let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    not_ready(d.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0), desired)
}

fn pod_problem(p: &Pod) -> Problem {
    let st = p.status.as_ref();
    let statuses = st.and_then(|s| s.container_statuses.as_deref()).unwrap_or_default();
    let terminating = p.metadata.deletion_timestamp.is_some();
    if let Some((c, reason)) = container_reason(statuses) {
        // Same precedence as the badge: an err reason wins over Terminating.
        if !terminating || POD_ERR_REASONS.contains(&reason.as_str()) {
            let message = container_message(c, &reason);
            return own(reason, message);
        }
    }
    if terminating {
        return own("Terminating", None);
    }
    let conds = st.and_then(|s| s.conditions.as_deref()).unwrap_or_default();
    if let Some(c) = conds.iter().find(|c| c.type_ == "PodScheduled" && c.status == "False") {
        return own(c.reason.clone().unwrap_or_else(|| "Unschedulable".into()), c.message.clone());
    }
    let phase = st.and_then(|s| s.phase.clone()).unwrap_or_else(|| "Unknown".into());
    if phase != "Running" {
        return own(phase, st.and_then(|s| s.message.clone()));
    }
    let names: Vec<&str> = statuses
        .iter()
        .filter(|c| !c.ready && !is_completed(c))
        .map(|c| c.name.as_str())
        .collect();
    own(
        "Not ready",
        (!names.is_empty()).then(|| format!("containers not ready: {}", names.join(", "))),
    )
}

/// `container <name>: <text>`: for CrashLoopBackOff the last run's exit code, for a terminated
/// container its exit code and message, otherwise the waiting message.
fn container_message(c: &ContainerStatus, reason: &str) -> Option<String> {
    let state = c.state.as_ref();
    let waiting = state.and_then(|s| s.waiting.as_ref()).and_then(|w| w.message.clone());
    let terminated = state
        .and_then(|s| s.terminated.as_ref())
        .filter(|t| t.reason.as_deref() == Some(reason));
    let text = if reason == "CrashLoopBackOff" {
        c.last_state
            .as_ref()
            .and_then(|s| s.terminated.as_ref())
            .map(|t| format!("last exit code {} ({})", t.exit_code, t.reason.as_deref().unwrap_or("Error")))
            .or(waiting)
    } else if let Some(t) = terminated {
        Some(match &t.message {
            Some(m) => format!("exit code {}: {m}", t.exit_code),
            None => format!("exit code {}", t.exit_code),
        })
    } else {
        waiting
    }?;
    Some(format!("container {}: {text}", c.name))
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
                    let mut text = format!("{} {}", c.status, c.reason.clone().unwrap_or_default());
                    // The message says why a rollout is stuck (which ReplicaSet, which deadline).
                    if let Some(m) = c.message.as_deref().filter(|m| !m.is_empty()) {
                        text.push_str(" — ");
                        text.push_str(m);
                    }
                    (format!("Condition {}", c.type_), text)
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
        Object::NetworkPolicy(np) => {
            if let Some(spec) = np.spec.as_ref() {
                rows.push((
                    "Pod selector".into(),
                    super::selector::selector_text(&spec.pod_selector.clone().unwrap_or_default()),
                ));
                let types = super::relations::policy_types(spec);
                rows.push(("Policy types".into(), types.join(", ")));
                // Rules of a direction the policy does not restrict are ignored by Kubernetes.
                let in_effect = |dir: &str| types.iter().any(|t| t == dir);
                let note = |dir: &str| if in_effect(dir) { "" } else { " (not in effect)" };
                let ingress = spec.ingress.as_deref().unwrap_or_default();
                if in_effect("Ingress") && ingress.is_empty() {
                    rows.push(("Ingress".into(), "Default deny".into()));
                }
                for (i, r) in ingress.iter().enumerate() {
                    rows.push((
                        format!("Ingress {}", i + 1),
                        rule_text("from", r.from.as_deref(), r.ports.as_deref()) + note("Ingress"),
                    ));
                }
                let egress = spec.egress.as_deref().unwrap_or_default();
                if in_effect("Egress") && egress.is_empty() {
                    rows.push(("Egress".into(), "Default deny".into()));
                }
                for (i, r) in egress.iter().enumerate() {
                    rows.push((
                        format!("Egress {}", i + 1),
                        rule_text("to", r.to.as_deref(), r.ports.as_deref()) + note("Egress"),
                    ));
                }
            }
        }
        Object::Role(r) => push_rules(&mut rows, r.rules.as_deref().unwrap_or_default()),
        Object::ClusterRole(r) => push_rules(&mut rows, r.rules.as_deref().unwrap_or_default()),
        Object::RoleBinding(b) => {
            rows.push(("Role".into(), format!("{}/{}", b.role_ref.kind, b.role_ref.name)));
            rows.push((
                "Subjects".into(),
                super::rows::subjects_text(b.subjects.as_deref().unwrap_or_default()),
            ));
        }
        Object::ClusterRoleBinding(b) => {
            rows.push(("Role".into(), format!("{}/{}", b.role_ref.kind, b.role_ref.name)));
            rows.push((
                "Subjects".into(),
                super::rows::subjects_text(b.subjects.as_deref().unwrap_or_default()),
            ));
        }
        Object::Node(n) => {
            rows.push(("Status".into(), super::rows::node_ready_text(n)));
            rows.push(("Roles".into(), super::rows::node_roles(n)));
            if let Some(i) = n.status.as_ref().and_then(|s| s.node_info.as_ref()) {
                rows.push(("Kubelet".into(), i.kubelet_version.clone()));
                rows.push(("OS".into(), i.os_image.clone()));
            }
            for c in node_conditions(n).iter().filter(|c| c.type_ != "Ready" && c.status == "True") {
                rows.push((format!("Condition {}", c.type_), c.message.clone().unwrap_or_default()));
            }
        }
        _ => {}
    }
    rows
}

/// `from pods app=client; 10.0.0.0/8 on TCP 80`.
fn rule_text(dir: &str, peers: Option<&[NetworkPolicyPeer]>, ports: Option<&[NetworkPolicyPort]>) -> String {
    use super::selector::selector_text;
    let peers = match peers {
        None | Some([]) => "anywhere".to_string(),
        Some(ps) => ps
            .iter()
            .map(|p| match (&p.pod_selector, &p.namespace_selector, &p.ip_block) {
                (_, _, Some(b)) => match b.except.as_deref() {
                    Some(ex) if !ex.is_empty() => format!("{} except {}", b.cidr, ex.join(", ")),
                    _ => b.cidr.clone(),
                },
                (Some(pod), None, None) => format!("pods {}", selector_text(pod)),
                (None, Some(ns), None) => format!("namespaces {}", selector_text(ns)),
                (Some(pod), Some(ns), None) => format!("pods {} in namespaces {}", selector_text(pod), selector_text(ns)),
                (None, None, None) => "anywhere".to_string(),
            })
            .collect::<Vec<_>>()
            .join("; "),
    };
    let ports = match ports {
        None | Some([]) => "all ports".to_string(),
        Some(ps) => ps
            .iter()
            .map(|p| {
                let proto = p.protocol.clone().unwrap_or_else(|| "TCP".into());
                match &p.port {
                    Some(IntOrString::Int(n)) => format!("{proto} {n}"),
                    Some(IntOrString::String(s)) => format!("{proto} {s}"),
                    None => proto,
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
    };
    format!("{dir} {peers} on {ports}")
}

/// `Rule N`: `get, list pods, services` / `* deployments.apps` / `get /healthz`.
fn push_rules(rows: &mut SummaryRows, rules: &[PolicyRule]) {
    for (i, r) in rules.iter().enumerate() {
        let verbs = r.verbs.join(", ");
        let targets = if let Some(urls) = r.non_resource_urls.as_ref().filter(|u| !u.is_empty()) {
            urls.join(", ")
        } else {
            let groups = r.api_groups.as_deref().unwrap_or_default();
            r.resources
                .iter()
                .flatten()
                .flat_map(|res| {
                    groups
                        .iter()
                        .map(move |g| if g.is_empty() { res.clone() } else { format!("{res}.{g}") })
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        rows.push((format!("Rule {}", i + 1), format!("{verbs} {targets}")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Kind, Store};

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn node_health_and_problems() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let node = |n: &str| s.find(Kind::Node, None, n).unwrap();
        assert_eq!(describe(node("node-a"), &s), (Status::Ok, strs(&["Ready", "v1.36.1"])));
        let (st, _) = describe(node("node-b"), &s);
        assert_eq!(st, Status::Err);
        let p = problem(node("node-b"), st, &s).unwrap();
        assert_eq!(
            (p.reason.as_str(), p.message.as_deref()),
            ("NotReady", Some("Kubelet stopped posting node status."))
        );
        let (st, badges) = describe(node("node-c"), &s);
        assert_eq!(st, Status::Warn);
        assert!(badges.contains(&"MemoryPressure".to_string()));
        assert_eq!(problem(node("node-c"), st, &s).unwrap().reason, "MemoryPressure");
    }

    #[test]
    fn pods_picked_by_a_policy_carry_a_policy_badge() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let (_, badges) = describe(s.find(Kind::Pod, Some("s"), "web-1").unwrap(), &s);
        assert!(badges.contains(&"policy".to_string()), "{badges:?}");
        let (_, badges) = describe(s.find(Kind::Pod, Some("t"), "other-1").unwrap(), &s);
        assert!(!badges.contains(&"policy".to_string()), "admitted is not selected");
    }

    #[test]
    fn overview_shows_the_policy_types_in_effect() {
        let s = Store::from_yaml_docs(super::super::rows::tests::POLICY_TYPES).unwrap();
        let rows = |n: &str| summary(s.find(Kind::NetworkPolicy, Some("s"), n).unwrap());
        let get = |r: &SummaryRows, key: &str| r.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        let implicit = rows("implicit-egress");
        assert_eq!(get(&implicit, "Policy types").as_deref(), Some("Ingress, Egress"));
        assert_eq!(get(&implicit, "Egress 1").as_deref(), Some("to pods app=client on all ports"));
        let ingress_only = rows("implicit-ingress");
        assert_eq!(get(&ingress_only, "Policy types").as_deref(), Some("Ingress"));
        assert_eq!(get(&ingress_only, "Ingress").as_deref(), Some("Default deny"));
        assert_eq!(get(&ingress_only, "Egress"), None, "no egress rules: egress is not restricted");
        let egress_only = rows("egress-only");
        assert_eq!(get(&egress_only, "Policy types").as_deref(), Some("Egress"));
        assert_eq!(
            get(&egress_only, "Ingress 1").as_deref(),
            Some("from pods app=client on all ports (not in effect)")
        );
        assert_eq!(get(&egress_only, "Egress").as_deref(), Some("Default deny"));
    }

    #[test]
    fn overview_explains_policies_roles_and_bindings() {
        let s = Store::from_fixture("graph-extras").unwrap();
        let rows = |k: Kind, ns: Option<&str>, n: &str| summary(s.find(k, ns, n).unwrap());
        let get = |r: &SummaryRows, key: &str| r.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).unwrap_or_default();
        let np = rows(Kind::NetworkPolicy, Some("s"), "web-ingress");
        assert_eq!(get(&np, "Pod selector"), "app=web");
        assert_eq!(
            get(&np, "Ingress 1"),
            "from pods app=client; pods app=client in namespaces kubernetes.io/metadata.name=t; 10.0.0.0/8 on TCP 80"
        );
        assert_eq!(get(&rows(Kind::NetworkPolicy, Some("s"), "deny-all"), "Ingress"), "Default deny");
        let role = rows(Kind::Role, Some("s"), "reader");
        assert_eq!(get(&role, "Rule 1"), "get, list pods, services");
        assert_eq!(get(&role, "Rule 2"), "* deployments.apps");
        assert_eq!(get(&rows(Kind::ClusterRole, None, "unused"), "Rule 1"), "get /healthz");
        let rb = rows(Kind::RoleBinding, Some("s"), "web-reader");
        assert_eq!(get(&rb, "Role"), "Role/reader");
        assert_eq!(get(&rb, "Subjects"), "ServiceAccount s/web, User alice");
        let node = rows(Kind::Node, None, "node-a");
        assert_eq!(get(&node, "Status"), "Ready");
        assert_eq!(get(&node, "Kubelet"), "v1.36.1");
    }

    #[test]
    fn a_usage_badge_is_appended_without_touching_the_status() {
        let s = crate::metrics::usage::tests::sampled();
        let plain = Store::from_fixture("metrics").unwrap();
        let hot = s.find(Kind::Pod, Some("m"), "hot").unwrap();
        let (status, badges) = describe(hot, &s);
        let (plain_status, plain_badges) = describe(plain.find(Kind::Pod, Some("m"), "hot").unwrap(), &plain);
        assert_eq!(status, plain_status, "usage never changes the status");
        assert_eq!(badges.last().map(String::as_str), Some("mem 92%"));
        assert_eq!(badges[..badges.len() - 1], plain_badges[..]);
        let api = s.find(Kind::Deployment, Some("m"), "api").unwrap();
        assert_eq!(
            describe(api, &s).1,
            describe(plain.find(Kind::Deployment, Some("m"), "api").unwrap(), &plain).1,
            "20%/39%: no badge"
        );
    }

    fn problem_of(store: &Store, kind: Kind, name: &str) -> Option<Problem> {
        let obj = store.find(kind, Some("p"), name).unwrap();
        let (status, _) = describe(obj, store);
        problem(obj, status, store)
    }

    fn own(reason: &str, message: Option<&str>) -> Option<Problem> {
        Some(Problem {
            reason: reason.into(),
            message: message.map(str::to_owned),
            cause: None,
        })
    }

    #[test]
    fn pod_problems_name_the_container_and_kubelet_message() {
        let s = Store::from_fixture("problems").unwrap();
        assert_eq!(
            problem_of(&s, Kind::Pod, "pull"),
            own("ImagePullBackOff", Some("container web: Back-off pulling image \"nginx:nope\""))
        );
        assert_eq!(
            problem_of(&s, Kind::Pod, "crash"),
            own("CrashLoopBackOff", Some("container api: last exit code 1 (Error)"))
        );
        assert_eq!(
            problem_of(&s, Kind::Pod, "unsched"),
            own("Unschedulable", Some("0/3 nodes are available: 3 Insufficient cpu."))
        );
        assert_eq!(
            problem_of(&s, Kind::Pod, "halfready"),
            own("Not ready", Some("containers not ready: b"))
        );
    }

    #[test]
    fn long_messages_are_trimmed_to_300_characters() {
        let s = Store::from_fixture("problems").unwrap();
        let p = problem_of(&s, Kind::Pod, "chatty").unwrap();
        assert_eq!(p.reason, "CreateContainerConfigError");
        let m = p.message.unwrap();
        assert_eq!(m.chars().count(), 300);
        assert!(m.starts_with("container c: xxx") && m.ends_with('…'), "{m}");
    }

    #[test]
    fn workload_problems_prefer_the_controller_condition() {
        let s = Store::from_fixture("problems").unwrap();
        assert_eq!(
            problem_of(&s, Kind::Deployment, "deadline"),
            own(
                "ProgressDeadlineExceeded",
                Some("ReplicaSet \"deadline-1\" has timed out progressing.")
            )
        );
        assert_eq!(
            problem_of(&s, Kind::Deployment, "quota"),
            own("FailedCreate", Some("pods \"quota-1\" is forbidden: exceeded quota: compute"))
        );
        assert_eq!(problem_of(&s, Kind::Deployment, "slow"), own("2 of 3 not ready", None));
        assert_eq!(problem_of(&s, Kind::Deployment, "healthy"), None);
        assert_eq!(
            problem_of(&s, Kind::Job, "failed"),
            own("BackoffLimitExceeded", Some("Job has reached the specified backoff limit"))
        );
        assert_eq!(problem_of(&s, Kind::CronJob, "paused"), own("Suspended", None));
    }

    #[test]
    fn network_storage_and_scaling_problems() {
        let s = Store::from_fixture("problems").unwrap();
        assert_eq!(problem_of(&s, Kind::Service, "nopods"), own("Selects no pods", None));
        assert_eq!(problem_of(&s, Kind::Service, "down"), own("No ready endpoints", None));
        assert_eq!(
            problem_of(&s, Kind::Ingress, "ing"),
            own("Backend not found", Some("service \"missing\" does not exist"))
        );
        assert_eq!(problem_of(&s, Kind::PersistentVolumeClaim, "claim"), own("Pending", None));
        assert_eq!(
            problem_of(&s, Kind::HorizontalPodAutoscaler, "nometrics"),
            own("FailedGetResourceMetric", Some("unable to get metrics for resource cpu"))
        );
    }

    #[test]
    fn services_ingresses_and_hpas_turn_yellow_when_they_cannot_work() {
        let s = Store::from_fixture("problems").unwrap();
        let status = |kind, name| describe(s.find(kind, Some("p"), name).unwrap(), &s).0;
        assert_eq!(status(Kind::Service, "down"), Status::Warn);
        assert_eq!(status(Kind::Ingress, "ing"), Status::Warn);
        assert_eq!(status(Kind::HorizontalPodAutoscaler, "nometrics"), Status::Warn);
        // The existing healthy cases stay green.
        let st = Store::from_fixture("statuses").unwrap();
        assert_eq!(describe(st.find(Kind::Service, Some("s"), "matched").unwrap(), &st).0, Status::Ok);
        assert_eq!(describe(st.find(Kind::Ingress, Some("s"), "multi").unwrap(), &st).0, Status::Ok);
    }

    #[test]
    fn every_other_row_of_the_reason_table() {
        let s = Store::from_fixture("problems").unwrap();
        assert_eq!(problem_of(&s, Kind::StatefulSet, "db"), own("2 of 3 not ready", None));
        assert_eq!(problem_of(&s, Kind::DaemonSet, "agent"), own("1 of 3 not ready", None));
        assert_eq!(problem_of(&s, Kind::ReplicaSet, "rs"), own("2 of 2 not ready", None));
        assert_eq!(problem_of(&s, Kind::Deployment, "rolling"), own("Rolling out", None));
        assert_eq!(
            problem_of(&s, Kind::Pod, "failedpod"),
            own("Failed", Some("The node was low on resource: memory."))
        );
        assert_eq!(
            problem_of(&s, Kind::Pod, "pendingmsg"),
            own("Pending", Some("waiting for something"))
        );
        assert_eq!(problem_of(&s, Kind::Pod, "going"), own("Terminating", None));
        assert_eq!(
            problem_of(&s, Kind::Pod, "oom"),
            own("OOMKilled", Some("container c: exit code 137"))
        );
        assert_eq!(
            problem_of(&s, Kind::Pod, "errored"),
            own("Error", Some("container c: exit code 2: boom"))
        );
        assert_eq!(
            problem_of(&s, Kind::Ingress, "many"),
            own("Backend not found", Some("services \"gone-a\", \"gone-b\" do not exist"))
        );
        assert_eq!(
            problem_of(&s, Kind::HorizontalPodAutoscaler, "cantscale"),
            own("FailedGetScale", Some("no such target"))
        );
        assert_eq!(describe(s.find(Kind::Service, Some("p"), "headless").unwrap(), &s).0, Status::Ok);
        assert_eq!(problem_of(&s, Kind::Service, "headless"), None);
    }

    #[test]
    fn unknown_ready_and_terminating_pods_do_not_back_a_service() {
        let s = Store::from_fixture("problems").unwrap();
        assert_eq!(problem_of(&s, Kind::Service, "unk"), own("No ready endpoints", None));
        assert_eq!(problem_of(&s, Kind::Service, "goingsvc"), own("No ready endpoints", None));
    }

    #[test]
    fn only_running_pods_are_ready_and_a_pod_without_status_still_is() {
        let pod = |status: serde_json::Value| -> Pod {
            serde_json::from_value(serde_json::json!({ "metadata": { "name": "p" }, "status": status })).unwrap()
        };
        for phase in ["Pending", "Failed", "Succeeded"] {
            assert!(!pod_ready(&pod(serde_json::json!({ "phase": phase }))), "{phase}");
        }
        assert!(pod_ready(&pod(serde_json::json!({ "phase": "Running" }))));
        assert!(!pod_ready(&pod(
            serde_json::json!({ "phase": "Running", "conditions": [{ "type": "Ready", "status": "False" }] })
        )));
        assert!(pod_ready(&pod(serde_json::json!({}))));
        let bare: Pod = serde_json::from_value(serde_json::json!({ "metadata": { "name": "p" } })).unwrap();
        assert!(pod_ready(&bare));
    }

    #[test]
    fn a_problem_exists_exactly_when_the_status_is_warn_or_err() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("yaml") {
                continue;
            }
            let name = path.file_stem().unwrap().to_str().unwrap().to_owned();
            let Ok(store) = Store::from_fixture(&name) else { continue };
            for obj in store.iter() {
                let (status, _) = describe(obj, &store);
                assert_eq!(
                    problem(obj, status, &store).is_some(),
                    status >= Status::Warn,
                    "{name}: {:?}/{} is {status:?}",
                    obj.kind(),
                    obj.name()
                );
                checked += 1;
            }
        }
        assert!(checked > 50, "only {checked} objects checked");
    }

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

    fn describe_rolling(kind: Kind, name: &str) -> (Status, Vec<String>) {
        let s = Store::from_fixture("rolling").unwrap();
        describe(s.find(kind, Some("r"), name).unwrap(), &s)
    }

    #[test]
    fn rollouts_in_progress_get_a_rolling_badge() {
        let strs = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(describe_rolling(Kind::Deployment, "settled"), (Status::Ok, strs(&["3/3", "web:2"])));
        assert_eq!(
            describe_rolling(Kind::Deployment, "updating"),
            (Status::Warn, strs(&["3/3", "rolling 1/3", "web:3"]))
        );
        // The controller has not seen the latest spec yet.
        assert_eq!(
            describe_rolling(Kind::Deployment, "unseen"),
            (Status::Warn, strs(&["3/3", "rolling 3/3", "web:4"]))
        );
        // A stuck rollout stays an error.
        assert_eq!(
            describe_rolling(Kind::Deployment, "deadline"),
            (Status::Err, strs(&["0/3", "rolling 1/3", "web:bad"]))
        );
        assert_eq!(
            describe_rolling(Kind::StatefulSet, "db"),
            (Status::Warn, strs(&["3/3", "rolling 1/3", "postgres:17"]))
        );
        assert_eq!(
            describe_rolling(Kind::DaemonSet, "agent"),
            (Status::Warn, strs(&["4/4", "rolling 2/4", "agent:3"]))
        );
        // Not rolling although updated < desired: paused, OnDelete, partition already reached.
        assert_eq!(describe_rolling(Kind::Deployment, "paused"), (Status::Ok, strs(&["3/3", "web:5"])));
        assert_eq!(
            describe_rolling(Kind::StatefulSet, "ondelete"),
            (Status::Ok, strs(&["3/3", "postgres:18"]))
        );
        assert_eq!(
            describe_rolling(Kind::StatefulSet, "canary-done"),
            (Status::Ok, strs(&["5/5", "postgres:18"]))
        );
        assert_eq!(describe_rolling(Kind::DaemonSet, "manual"), (Status::Ok, strs(&["4/4", "agent:4"])));
        // Partitioned rollout that is still behind: 1 updated < 5 - 3.
        assert_eq!(
            describe_rolling(Kind::StatefulSet, "canary-behind"),
            (Status::Warn, strs(&["5/5", "rolling 1/5", "postgres:18"]))
        );
        // Unobserved generation and no updated count: no invented number.
        assert_eq!(
            describe_rolling(Kind::Deployment, "nocount"),
            (Status::Warn, strs(&["3/3", "rolling", "web:6"]))
        );
    }

    #[test]
    fn deployment_overview_carries_the_condition_message() {
        let s = Store::from_fixture("rolling").unwrap();
        let rows = summary(s.find(Kind::Deployment, Some("r"), "deadline").unwrap());
        assert!(
            rows.iter().any(|(k, v)| k == "Condition Progressing"
                && v == "False ProgressDeadlineExceeded — ReplicaSet \"deadline-2\" has timed out progressing."),
            "{rows:?}"
        );
    }
}
