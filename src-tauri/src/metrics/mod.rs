//! Pod CPU/memory usage from metrics-server: quantities, samples and usage math. Pure — the
//! poller that fetches samples lives in `session::metrics`.

pub mod quantity;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Whether the namespace has usage to show, and if not, why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetricsState {
    /// No poll has answered yet.
    #[default]
    Pending,
    Available,
    /// The Metrics API is not served (metrics-server missing).
    Unavailable,
    /// RBAC forbids listing `pods.metrics.k8s.io`.
    Forbidden,
}

/// One pod's usage, summed over its containers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PodUsage {
    pub cpu_millis: u64,
    pub memory_bytes: u64,
}

impl std::ops::Add for PodUsage {
    type Output = PodUsage;
    fn add(self, o: PodUsage) -> PodUsage {
        PodUsage {
            cpu_millis: self.cpu_millis.saturating_add(o.cpu_millis),
            memory_bytes: self.memory_bytes.saturating_add(o.memory_bytes),
        }
    }
}

/// The latest sample of the selected namespace, keyed by pod name.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MetricsSample {
    pub state: MetricsState,
    pub pods: HashMap<String, PodUsage>,
}

/// Payload of the `metrics_updated` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetricsUpdate {
    pub state: MetricsState,
}
