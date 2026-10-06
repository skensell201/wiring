//! Kubernetes label selectors (`matchLabels` + `matchExpressions`), as NetworkPolicies use them.
//! Unlike a Service's plain map selector, an empty `LabelSelector` matches every object.

use std::collections::BTreeMap;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;

pub fn label_selector_matches(sel: &LabelSelector, labels: Option<&BTreeMap<String, String>>) -> bool {
    let empty = BTreeMap::new();
    let labels = labels.unwrap_or(&empty);
    let by_labels = sel
        .match_labels
        .as_ref()
        .is_none_or(|m| m.iter().all(|(k, v)| labels.get(k) == Some(v)));
    by_labels
        && sel.match_expressions.iter().flatten().all(|r| {
            let values = r.values.as_deref().unwrap_or_default();
            let value = labels.get(&r.key);
            match r.operator.as_str() {
                "In" => value.is_some_and(|v| values.contains(v)),
                "NotIn" => value.is_none_or(|v| !values.contains(v)),
                "Exists" => value.is_some(),
                "DoesNotExist" => value.is_none(),
                _ => false,
            }
        })
}

/// `app=web, env in (prod,stage), !canary`; `all pods` for an empty selector.
pub fn selector_text(sel: &LabelSelector) -> String {
    let mut parts: Vec<String> = sel.match_labels.iter().flatten().map(|(k, v)| format!("{k}={v}")).collect();
    for r in sel.match_expressions.iter().flatten() {
        let values = r.values.as_deref().unwrap_or_default().join(",");
        parts.push(match r.operator.as_str() {
            "In" => format!("{} in ({values})", r.key),
            "NotIn" => format!("{} notin ({values})", r.key),
            "Exists" => r.key.clone(),
            "DoesNotExist" => format!("!{}", r.key),
            op => format!("{} {op} ({values})", r.key),
        });
    }
    if parts.is_empty() {
        "all pods".into()
    } else {
        parts.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, LabelSelectorRequirement};
    use std::collections::BTreeMap;

    fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn expr(key: &str, op: &str, values: &[&str]) -> LabelSelectorRequirement {
        LabelSelectorRequirement {
            key: key.into(),
            operator: op.into(),
            values: if values.is_empty() {
                None
            } else {
                Some(values.iter().map(|v| v.to_string()).collect())
            },
        }
    }

    #[test]
    fn an_empty_selector_matches_everything() {
        let all = LabelSelector::default();
        assert!(label_selector_matches(&all, Some(&labels(&[("app", "web")]))));
        assert!(label_selector_matches(&all, None));
        assert_eq!(selector_text(&all), "all pods");
    }

    #[test]
    fn match_labels_must_all_be_present() {
        let sel = LabelSelector {
            match_labels: Some(labels(&[("app", "web"), ("tier", "fe")])),
            ..Default::default()
        };
        assert!(label_selector_matches(
            &sel,
            Some(&labels(&[("app", "web"), ("tier", "fe"), ("x", "y")]))
        ));
        assert!(!label_selector_matches(&sel, Some(&labels(&[("app", "web")]))));
        assert!(!label_selector_matches(&sel, None));
    }

    #[test]
    fn every_operator() {
        let l = labels(&[("env", "prod"), ("team", "a")]);
        let one = |e: LabelSelectorRequirement| LabelSelector {
            match_expressions: Some(vec![e]),
            ..Default::default()
        };
        assert!(label_selector_matches(&one(expr("env", "In", &["prod", "stage"])), Some(&l)));
        assert!(!label_selector_matches(&one(expr("env", "In", &["dev"])), Some(&l)));
        assert!(label_selector_matches(&one(expr("env", "NotIn", &["dev"])), Some(&l)));
        assert!(!label_selector_matches(&one(expr("env", "NotIn", &["prod"])), Some(&l)));
        assert!(label_selector_matches(&one(expr("missing", "NotIn", &["x"])), Some(&l)));
        assert!(label_selector_matches(&one(expr("team", "Exists", &[])), Some(&l)));
        assert!(!label_selector_matches(&one(expr("missing", "Exists", &[])), Some(&l)));
        assert!(label_selector_matches(&one(expr("missing", "DoesNotExist", &[])), Some(&l)));
        assert!(!label_selector_matches(&one(expr("team", "DoesNotExist", &[])), Some(&l)));
        assert!(
            !label_selector_matches(&one(expr("team", "Bogus", &[])), Some(&l)),
            "unknown operators never match"
        );
    }

    #[test]
    fn text_reads_like_kubectl() {
        let sel = LabelSelector {
            match_labels: Some(labels(&[("app", "web")])),
            match_expressions: Some(vec![expr("env", "In", &["prod", "stage"]), expr("canary", "DoesNotExist", &[])]),
        };
        assert_eq!(selector_text(&sel), "app=web, env in (prod,stage), !canary");
    }
}
