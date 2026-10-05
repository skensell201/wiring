//! `metrics.k8s.io/v1beta1` PodMetrics items → usage per pod.

use std::collections::HashMap;

use serde_json::Value;

use super::{quantity, PodUsage};

/// Usage per pod name, summed over its containers. An item without a name, or with a quantity
/// that does not parse, is skipped rather than shown as a wrong number.
pub fn parse_pod_metrics(items: &[Value]) -> HashMap<String, PodUsage> {
    items
        .iter()
        .filter_map(|item| {
            let name = item.pointer("/metadata/name")?.as_str()?.to_string();
            let mut total = PodUsage::default();
            for c in item.get("containers")?.as_array()? {
                total = total
                    + PodUsage {
                        cpu_millis: quantity::cpu_millis(c.pointer("/usage/cpu")?.as_str()?)?,
                        memory_bytes: quantity::memory_bytes(c.pointer("/usage/memory")?.as_str()?)?,
                    };
            }
            Some((name, total))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::PodUsage;
    use serde_json::json;

    #[test]
    fn containers_are_summed_per_pod_and_broken_items_skipped() {
        let items = vec![
            json!({ "metadata": { "name": "a" }, "containers": [
                { "name": "app", "usage": { "cpu": "120m", "memory": "60Mi" } },
                { "name": "sidecar", "usage": { "cpu": "5m", "memory": "4Mi" } } ] }),
            json!({ "metadata": { "name": "b" }, "containers": [
                { "name": "app", "usage": { "cpu": "1234567n", "memory": "2048Ki" } } ] }),
            json!({ "metadata": { "name": "broken" }, "containers": [
                { "name": "app", "usage": { "cpu": "lots", "memory": "1Mi" } } ] }),
            json!({ "containers": [] }),
        ];
        let pods = parse_pod_metrics(&items);
        assert_eq!(pods.len(), 2);
        assert_eq!(
            pods["a"],
            PodUsage {
                cpu_millis: 125,
                memory_bytes: 64 << 20
            }
        );
        assert_eq!(
            pods["b"],
            PodUsage {
                cpu_millis: 1,
                memory_bytes: 2 << 20
            }
        );
    }

    #[test]
    fn a_new_store_has_a_pending_empty_sample() {
        let store = crate::store::Store::default();
        assert_eq!(store.metrics.state, crate::metrics::MetricsState::Pending);
        assert!(store.metrics.pods.is_empty());
    }
}
