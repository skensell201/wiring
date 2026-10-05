//! Usage against requests and limits, for pods and the workloads that own them.

use k8s_openapi::api::core::v1::{Container, Pod};

use super::quantity::{cpu_millis, fmt_cpu, fmt_memory, memory_bytes};
use super::{MetricsState, PodUsage};
use crate::graph::build::{is_owned_by, OWNER_CHAIN_DEPTH};
use crate::store::{Kind, Object, Store};

/// Usage at or above this share of a limit earns the node a badge.
const BADGE_PERCENT: u64 = 80;

/// Kinds that carry usage: pods, and the workloads that own pods (directly or through a ReplicaSet).
pub fn has_usage(kind: Kind) -> bool {
    matches!(kind, Kind::Pod | Kind::Deployment | Kind::StatefulSet | Kind::DaemonSet)
}

/// The pods `obj` stands for: itself for a Pod, the pods it owns for a workload.
fn pods_of<'a>(store: &'a Store, obj: &'a Object) -> Vec<&'a Pod> {
    match obj {
        Object::Pod(p) => vec![p],
        Object::Deployment(_) | Object::StatefulSet(_) | Object::DaemonSet(_) => store
            .iter_kind(Kind::Pod)
            .filter(|p| is_owned_by(store, p, obj.kind(), obj.name(), OWNER_CHAIN_DEPTH))
            .filter_map(|p| match p {
                Object::Pod(p) => Some(p),
                _ => None,
            })
            .collect(),
        _ => vec![],
    }
}

/// The summed usage of `obj`'s pods that have a sample; `None` when none has one.
pub fn usage(store: &Store, obj: &Object) -> Option<PodUsage> {
    if store.metrics.state != MetricsState::Available || !has_usage(obj.kind()) {
        return None;
    }
    pods_of(store, obj)
        .into_iter()
        .filter_map(|p| p.metadata.name.as_deref().and_then(|n| store.metrics.pods.get(n)))
        .copied()
        .reduce(|a, b| a + b)
}

/// Requests and limits summed over every container of the pods of `obj` that have a sample — the
/// same pods `usage` counts, so a percentage never divides one pod's usage by two pods' limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Resources {
    pub cpu_request: Option<u64>,
    pub cpu_limit: Option<u64>,
    pub memory_request: Option<u64>,
    pub memory_limit: Option<u64>,
}

fn quantity<'c>(c: &'c Container, limits: bool, key: &str) -> Option<&'c str> {
    let r = c.resources.as_ref()?;
    let map = if limits { r.limits.as_ref() } else { r.requests.as_ref() }?;
    map.get(key).map(|q| q.0.as_str())
}

/// The sum over `containers`, or `None` when there are none or any one lacks the value — a
/// single unbounded container makes a percentage of the others meaningless.
fn total(containers: &[&Container], pick: impl Fn(&Container) -> Option<u64>) -> Option<u64> {
    if containers.is_empty() {
        return None;
    }
    containers.iter().map(|c| pick(c)).sum()
}

pub fn resources(store: &Store, obj: &Object) -> Resources {
    let containers: Vec<&Container> = pods_of(store, obj)
        .into_iter()
        .filter(|p| p.metadata.name.as_deref().is_some_and(|n| store.metrics.pods.contains_key(n)))
        .filter_map(|p| p.spec.as_ref())
        .flat_map(|s| s.containers.iter())
        .collect();
    Resources {
        cpu_request: total(&containers, |c| quantity(c, false, "cpu").and_then(cpu_millis)),
        cpu_limit: total(&containers, |c| quantity(c, true, "cpu").and_then(cpu_millis)),
        memory_request: total(&containers, |c| quantity(c, false, "memory").and_then(memory_bytes)),
        memory_limit: total(&containers, |c| quantity(c, true, "memory").and_then(memory_bytes)),
    }
}

/// `used` as a rounded percentage of `of`.
fn percent(used: u64, of: u64) -> Option<u64> {
    (of > 0).then(|| (used * 100 + of / 2) / of)
}

/// The table's CPU and Memory cells: `kubectl top` values, `—` without a sample.
pub fn usage_cells(store: &Store, obj: &Object) -> (String, String) {
    match usage(store, obj) {
        Some(u) => (fmt_cpu(u.cpu_millis), fmt_memory(u.memory_bytes)),
        None => ("—".into(), "—".into()),
    }
}

/// `120m / req 100m / lim 500m (24%)`: the percentage is of the limit, else of the request.
fn line(used: u64, request: Option<u64>, limit: Option<u64>, fmt: fn(u64) -> String) -> String {
    let mut s = fmt(used);
    if let Some(r) = request {
        s.push_str(&format!(" / req {}", fmt(r)));
    }
    if let Some(l) = limit {
        s.push_str(&format!(" / lim {}", fmt(l)));
    }
    if let Some(p) = limit.or(request).and_then(|of| percent(used, of)) {
        s.push_str(&format!(" ({p}%)"));
    }
    s
}

/// Overview rows for `obj`'s usage, or one `Usage` row saying why there is none. Empty for kinds
/// without usage.
pub fn usage_rows(store: &Store, obj: &Object) -> Vec<(String, String)> {
    if !has_usage(obj.kind()) {
        return vec![];
    }
    let note = |text: &str| vec![("Usage".to_string(), text.to_string())];
    match store.metrics.state {
        MetricsState::Pending => return note("waiting for the first metrics sample"),
        MetricsState::Unavailable => return note("Metrics API not available (install metrics-server)"),
        MetricsState::Forbidden => return note("No access to pod metrics (RBAC)"),
        MetricsState::Available => {}
    }
    let Some(used) = usage(store, obj) else {
        return note("no sample yet");
    };
    let r = resources(store, obj);
    vec![
        ("CPU usage".into(), line(used.cpu_millis, r.cpu_request, r.cpu_limit, fmt_cpu)),
        (
            "Memory usage".into(),
            line(used.memory_bytes, r.memory_request, r.memory_limit, fmt_memory),
        ),
    ]
}

/// `mem 92%` / `cpu 85%` once usage reaches 80 % of a limit — the higher of the two, memory on a
/// tie (an OOM kill hurts more than throttling).
pub fn usage_badge(store: &Store, obj: &Object) -> Option<String> {
    let used = usage(store, obj)?;
    let r = resources(store, obj);
    let hot = |used: u64, limit: Option<u64>, label: &'static str| {
        let limit = limit.filter(|&l| l > 0 && used * 100 >= l * BADGE_PERCENT)?;
        Some((percent(used, limit)?, label))
    };
    let mem = hot(used.memory_bytes, r.memory_limit, "mem");
    let cpu = hot(used.cpu_millis, r.cpu_limit, "cpu");
    let (pct, label) = match (mem, cpu) {
        (Some(m), Some(c)) if c.0 > m.0 => c,
        (Some(m), _) => m,
        (None, Some(c)) => c,
        (None, None) => return None,
    };
    Some(format!("{label} {pct}%"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::metrics::{MetricsSample, MetricsState, PodUsage};

    const MI: u64 = 1 << 20;

    /// The `metrics` fixture with a sample for every pod but `unsampled`.
    pub(crate) fn sampled() -> Store {
        let mut s = Store::from_fixture("metrics").unwrap();
        let usage = |cpu_millis, mi: u64| PodUsage {
            cpu_millis,
            memory_bytes: mi * MI,
        };
        s.metrics = MetricsSample {
            state: MetricsState::Available,
            pods: [
                ("api-1-a", usage(120, 60)),
                ("api-1-b", usage(80, 40)),
                ("db-0", usage(50, 128)),
                ("hot", usage(300, 92)),
                ("tie", usage(900, 90)),
                ("cpuhot", usage(850, 10)),
                ("free", usage(40, 20)),
            ]
            .into_iter()
            .map(|(n, u)| (n.to_string(), u))
            .collect(),
        };
        s
    }

    fn obj<'a>(s: &'a Store, kind: Kind, name: &str) -> &'a Object {
        s.find(kind, Some("m"), name).unwrap()
    }

    #[test]
    fn workloads_sum_the_pods_they_own() {
        let s = sampled();
        assert_eq!(
            usage(&s, obj(&s, Kind::Deployment, "api")),
            Some(PodUsage {
                cpu_millis: 200,
                memory_bytes: 100 * MI
            })
        );
        assert_eq!(
            usage(&s, obj(&s, Kind::StatefulSet, "db")),
            Some(PodUsage {
                cpu_millis: 50,
                memory_bytes: 128 * MI
            })
        );
        assert_eq!(usage(&s, obj(&s, Kind::Pod, "unsampled")), None);
        assert_eq!(usage(&s, obj(&s, Kind::ReplicaSet, "api-1")), None, "ReplicaSets carry no usage");
    }

    #[test]
    fn requests_and_limits_are_summed_and_absent_when_any_container_lacks_them() {
        let s = sampled();
        assert_eq!(
            resources(&s, obj(&s, Kind::Deployment, "api")),
            Resources {
                cpu_request: Some(200),
                cpu_limit: Some(1000),
                memory_request: Some(128 * MI),
                memory_limit: Some(256 * MI)
            }
        );
        assert_eq!(
            resources(&s, obj(&s, Kind::StatefulSet, "db")),
            Resources {
                cpu_request: Some(100),
                cpu_limit: None,
                memory_request: Some(256 * MI),
                memory_limit: None
            }
        );
        assert_eq!(resources(&s, obj(&s, Kind::Pod, "free")), Resources::default());
    }

    #[test]
    fn cells_print_like_kubectl_top_or_a_dash() {
        let s = sampled();
        assert_eq!(usage_cells(&s, obj(&s, Kind::Deployment, "api")), ("200m".into(), "100Mi".into()));
        assert_eq!(usage_cells(&s, obj(&s, Kind::Pod, "unsampled")), ("—".into(), "—".into()));
        let pending = Store::from_fixture("metrics").unwrap();
        assert_eq!(usage_cells(&pending, obj(&pending, Kind::Pod, "hot")), ("—".into(), "—".into()));
    }

    #[test]
    fn overview_rows_show_usage_against_requests_and_limits() {
        let s = sampled();
        let rows = |kind, name| usage_rows(&s, obj(&s, kind, name));
        assert_eq!(
            rows(Kind::Deployment, "api"),
            vec![
                ("CPU usage".to_string(), "200m / req 200m / lim 1000m (20%)".to_string()),
                ("Memory usage".to_string(), "100Mi / req 128Mi / lim 256Mi (39%)".to_string()),
            ]
        );
        assert_eq!(
            rows(Kind::StatefulSet, "db"),
            vec![
                ("CPU usage".to_string(), "50m / req 100m (50%)".to_string()),
                ("Memory usage".to_string(), "128Mi / req 256Mi (50%)".to_string()),
            ]
        );
        assert_eq!(
            rows(Kind::Pod, "free"),
            vec![
                ("CPU usage".to_string(), "40m".to_string()),
                ("Memory usage".to_string(), "20Mi".to_string())
            ]
        );
        assert_eq!(
            rows(Kind::Pod, "unsampled"),
            vec![("Usage".to_string(), "no sample yet".to_string())]
        );
        assert!(usage_rows(&s, obj(&s, Kind::ReplicaSet, "api-1")).is_empty());
    }

    #[test]
    fn overview_rows_explain_a_missing_sample() {
        for (state, text) in [
            (MetricsState::Pending, "waiting for the first metrics sample"),
            (MetricsState::Unavailable, "Metrics API not available (install metrics-server)"),
            (MetricsState::Forbidden, "No access to pod metrics (RBAC)"),
        ] {
            let mut s = Store::from_fixture("metrics").unwrap();
            s.metrics.state = state;
            assert_eq!(
                usage_rows(&s, obj(&s, Kind::Pod, "hot")),
                vec![("Usage".to_string(), text.to_string())]
            );
        }
    }

    #[test]
    fn a_badge_appears_at_80_percent_of_a_limit() {
        let s = sampled();
        let badge = |kind, name| usage_badge(&s, obj(&s, kind, name));
        assert_eq!(badge(Kind::Pod, "hot"), Some("mem 92%".into()));
        assert_eq!(badge(Kind::Pod, "tie"), Some("mem 90%".into()), "memory wins a tie");
        assert_eq!(badge(Kind::Pod, "cpuhot"), Some("cpu 85%".into()));
        assert_eq!(badge(Kind::Deployment, "api"), None, "20% / 39%");
        assert_eq!(badge(Kind::StatefulSet, "db"), None, "requests only: no limit, no badge");
        assert_eq!(badge(Kind::Pod, "free"), None);
        assert_eq!(badge(Kind::Pod, "unsampled"), None);
    }

    /// A StatefulSet `web` whose pod `web-1` has no sample (new, Pending or completed).
    fn half_sampled() -> Store {
        let pod = |name: &str| {
            format!(
                "apiVersion: v1\nkind: Pod\nmetadata:\n  name: {name}\n  namespace: m\n  ownerReferences: [ {{ apiVersion: apps/v1, kind: StatefulSet, name: web, uid: s-web }} ]\nspec:\n  containers: [ {{ name: c, image: x, resources: {{ requests: {{ cpu: 100m, memory: 50Mi }}, limits: {{ cpu: 200m, memory: 100Mi }} }} }} ]\n"
            )
        };
        let yaml = format!(
            "apiVersion: apps/v1\nkind: StatefulSet\nmetadata: {{ name: web, namespace: m }}\nspec: {{ replicas: 2, serviceName: web, selector: {{ matchLabels: {{ app: web }} }}, template: {{ spec: {{ containers: [ {{ name: c, image: x }} ] }} }} }}\n---\n{}---\n{}",
            pod("web-0"),
            pod("web-1")
        );
        let mut s = Store::from_yaml_docs(&yaml).unwrap();
        s.metrics = MetricsSample {
            state: MetricsState::Available,
            pods: [(
                "web-0".to_string(),
                PodUsage {
                    cpu_millis: 100,
                    memory_bytes: 90 * MI,
                },
            )]
            .into_iter()
            .collect(),
        };
        s
    }

    #[test]
    fn only_pods_with_a_sample_count_towards_requests_and_limits() {
        let s = half_sampled();
        let web = obj(&s, Kind::StatefulSet, "web");
        assert_eq!(
            resources(&s, web),
            Resources {
                cpu_request: Some(100),
                cpu_limit: Some(200),
                memory_request: Some(50 * MI),
                memory_limit: Some(100 * MI)
            },
            "web-1 has no sample, so its resources are left out like its usage"
        );
        assert_eq!(usage_badge(&s, web), Some("mem 90%".into()));
        assert_eq!(usage_rows(&s, web)[1].1, "90Mi / req 50Mi / lim 100Mi (90%)");
    }
}
