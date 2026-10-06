//! The part of kubectl's JSONPath that CRD printer columns use in practice: `.a.b`,
//! `.a[0].b`, `.a[*].b`, `['quoted.key']`, `[?(@.k=="v")]`, optionally wrapped in `{…}` or
//! started with `$`. Anything else is unsupported; its column shows `—`.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
enum Step {
    Field(String),
    Index(i64),
    All,
    /// `[?(@.a.b=="v")]`: the array items whose `a.b` renders as `v`.
    Filter {
        path: Vec<String>,
        value: String,
    },
}

fn unquote(s: &str) -> Option<String> {
    let s = s.trim();
    let inner = s
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .or_else(|| s.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')))?;
    Some(inner.to_string())
}

fn parse_filter(expr: &str) -> Option<Step> {
    let (left, right) = expr.split_once("==")?;
    let path: Vec<String> = left.trim().strip_prefix("@.")?.split('.').map(str::to_string).collect();
    if path.iter().any(String::is_empty) {
        return None;
    }
    Some(Step::Filter {
        path,
        value: unquote(right)?,
    })
}

fn parse(path: &str) -> Option<Vec<Step>> {
    let mut s = path.trim();
    if let Some(inner) = s.strip_prefix('{').and_then(|r| r.strip_suffix('}')) {
        s = inner.trim();
    }
    let s = s.strip_prefix('$').unwrap_or(s);
    if s.is_empty() {
        return None;
    }
    let bytes = s.as_bytes();
    let mut steps = Vec::new();
    let mut i = 0;
    while i < s.len() {
        match bytes[i] {
            b'.' => {
                i += 1;
                let start = i;
                while i < s.len() && bytes[i] != b'.' && bytes[i] != b'[' {
                    i += 1;
                }
                if start == i {
                    return None; // `..` (recursive descent) or a trailing dot
                }
                steps.push(Step::Field(s[start..i].to_string()));
            }
            b'[' => {
                let rest = &s[i + 1..];
                if let Some(filter) = rest.strip_prefix("?(") {
                    let close = filter.find(")]")?;
                    steps.push(parse_filter(&filter[..close])?);
                    i += 1 + 2 + close + 2;
                } else {
                    let close = rest.find(']')?;
                    let inner = rest[..close].trim();
                    steps.push(if inner == "*" {
                        Step::All
                    } else if inner.starts_with('\'') || inner.starts_with('"') {
                        Step::Field(unquote(inner)?)
                    } else {
                        Step::Index(inner.parse().ok()?)
                    });
                    i += 1 + close + 1;
                }
            }
            _ => return None,
        }
    }
    Some(steps)
}

fn eval<'a>(steps: &[Step], root: &'a Value) -> Vec<&'a Value> {
    let mut current = vec![root];
    for step in steps {
        let mut next = Vec::new();
        for v in current {
            match step {
                Step::Field(k) => next.extend(v.get(k.as_str())),
                Step::Index(n) => {
                    let at = if *n < 0 {
                        v.as_array().and_then(|a| a.len().checked_sub(n.unsigned_abs() as usize))
                    } else {
                        usize::try_from(*n).ok()
                    };
                    next.extend(at.and_then(|i| v.get(i)));
                }
                Step::All => match v {
                    Value::Array(items) => next.extend(items.iter()),
                    Value::Object(map) => next.extend(map.values()),
                    _ => {}
                },
                Step::Filter { path, value } => {
                    if let Value::Array(items) = v {
                        for item in items {
                            let field = path.iter().try_fold(item, |cur, k| cur.get(k.as_str()));
                            if field.is_some_and(|f| text(f) == *value) {
                                next.push(item);
                            }
                        }
                    }
                }
            }
        }
        current = next;
    }
    current
}

fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(_) | Value::Number(_) => v.to_string(),
        _ => serde_json::to_string(v).unwrap_or_default(),
    }
}

/// The column text for `path` on `obj`: the first match, as the apiserver's table converter
/// shows it (empty when nothing matches);
/// `None` when the path is outside the supported subset.
pub fn render(path: &str, obj: &Value) -> Option<String> {
    let steps = parse(path)?;
    Some(eval(&steps, obj).into_iter().next().map(text).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj() -> serde_json::Value {
        json!({
            "metadata": { "name": "web", "annotations": { "example.com/tier": "gold" } },
            "spec": { "replicas": 3, "paused": false, "hosts": ["a.example.com", "b.example.com"],
                      "rules": [{ "port": 80 }, { "port": 443 }], "selector": { "app": "web" } },
            "status": { "conditions": [
                { "type": "Ready", "status": "True", "reason": "Issued" },
                { "type": "Issuing", "status": "False" }
            ] }
        })
    }

    #[test]
    fn fields_indexes_and_wildcards() {
        let o = obj();
        assert_eq!(render(".metadata.name", &o).as_deref(), Some("web"));
        assert_eq!(render(".spec.replicas", &o).as_deref(), Some("3"));
        assert_eq!(render(".spec.paused", &o).as_deref(), Some("false"));
        assert_eq!(render(".spec.hosts[0]", &o).as_deref(), Some("a.example.com"));
        assert_eq!(render(".spec.rules[1].port", &o).as_deref(), Some("443"));
        assert_eq!(render(".spec.rules[*].port", &o).as_deref(), Some("80"));
        assert_eq!(render(".spec.hosts[*]", &o).as_deref(), Some("a.example.com"));
    }

    #[test]
    fn filters_pick_matching_array_items() {
        let o = obj();
        assert_eq!(
            render(".status.conditions[?(@.type==\"Ready\")].status", &o).as_deref(),
            Some("True")
        );
        assert_eq!(
            render(".status.conditions[?(@.type=='Issuing')].status", &o).as_deref(),
            Some("False")
        );
        assert_eq!(render(".status.conditions[?(@.type==\"Gone\")].status", &o).as_deref(), Some(""));
    }

    #[test]
    fn quoted_keys_braces_and_dollar() {
        let o = obj();
        assert_eq!(render(".metadata.annotations['example.com/tier']", &o).as_deref(), Some("gold"));
        assert_eq!(render("{.metadata.name}", &o).as_deref(), Some("web"));
        assert_eq!(render("$.metadata.name", &o).as_deref(), Some("web"));
    }

    #[test]
    fn objects_render_as_compact_json_and_missing_paths_as_empty() {
        let o = obj();
        assert_eq!(render(".spec.selector", &o).as_deref(), Some(r#"{"app":"web"}"#));
        assert_eq!(render(".spec.nothing.here", &o).as_deref(), Some(""));
        assert_eq!(render(".spec.hosts[9]", &o).as_deref(), Some(""));
    }

    #[test]
    fn negative_index_counts_from_the_end() {
        let o = obj();
        assert_eq!(render(".spec.hosts[-1]", &o).as_deref(), Some("b.example.com"));
        assert_eq!(render(".spec.hosts[-2]", &o).as_deref(), Some("a.example.com"));
        assert_eq!(render(".spec.hosts[-3]", &o).as_deref(), Some(""));
    }

    #[test]
    fn several_matches_show_only_the_first() {
        let o = obj();
        assert_eq!(render(".spec.rules[*].port", &o).as_deref(), Some("80"));
        assert_eq!(render(".status.conditions[*].type", &o).as_deref(), Some("Ready"));
    }

    #[test]
    fn unsupported_paths_are_none() {
        let o = obj();
        for path in [
            "..name",
            ".spec.hosts[0:1]",
            ".spec.hosts[-]",
            ".spec.hosts[--1]",
            "spec.replicas",
            ".spec[?(@.x>1)]",
            "",
        ] {
            assert_eq!(render(path, &o), None, "{path}");
        }
    }
}
