//! Pod CPU/memory usage from metrics-server: quantities, samples and usage math. Pure — the
//! poller that fetches samples lives in `session::metrics`.

pub mod quantity;
pub mod sample;
pub mod usage;

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

/// A sample older than this is shown as stale (four missed polls).
pub const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

/// The latest sample of the selected namespace, keyed by pod name.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MetricsSample {
    pub state: MetricsState,
    /// `Unavailable` because metrics-server is registered but keeps failing (not because it is
    /// missing); polling goes on and a sample turns the state back to `Available`.
    pub unresponsive: bool,
    /// When the sample in `pods` arrived.
    pub sampled_at: Option<std::time::Instant>,
    pub pods: HashMap<String, PodUsage>,
}

impl MetricsSample {
    pub fn is_stale(&self) -> bool {
        self.sampled_at.is_some_and(|t| t.elapsed() > STALE_AFTER)
    }
}

/// Payload of the `metrics_updated` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetricsUpdate {
    pub state: MetricsState,
}
