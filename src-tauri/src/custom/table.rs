//! `kubectl get`-style rows for a custom kind: Name, (Namespace), its printer columns, Age.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
use k8s_openapi::jiff;
use serde_json::Value;

use super::id::custom_node_id;
use super::jsonpath;
use crate::discovery::CustomKind;
use crate::graph::rows::{age, col, plain, Table, TableRow};
use crate::graph::Status;
use crate::store::Kind;

const CREATION: &str = ".metadata.creationTimestamp";

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(v, |cur, k| cur.get(*k))?.as_str()
}

fn timestamp(s: &str) -> Option<Time> {
    s.parse::<jiff::Timestamp>().ok().map(Time)
}

/// `Ready=True` ok, `Ready=False` err, anything else (no Ready condition) unknown.
fn row_status(obj: &Value) -> Status {
    let ready = obj["status"]["conditions"]
        .as_array()
        .and_then(|cs| cs.iter().find(|c| c["type"] == "Ready"))
        .and_then(|c| c["status"].as_str());
    match ready {
        Some("True") => Status::Ok,
        Some("False") => Status::Err,
        _ => Status::Unknown,
    }
}

pub fn table(kind: &CustomKind, objects: &[Value], multi: bool, now: jiff::Timestamp) -> Table {
    let r = &kind.resource;
    let with_namespace = multi && r.namespaced;
    let printer: Vec<_> = kind.columns.iter().filter(|c| c.json_path.trim() != CREATION).collect();
    let mut columns = Vec::new();
    if with_namespace {
        columns.push(col("namespace", "Namespace", false));
    }
    columns.push(col("name", "Name", false));
    for (i, c) in printer.iter().enumerate() {
        columns.push(col(&format!("c{i}"), &c.name, c.type_ == "integer" || c.type_ == "number"));
    }
    columns.push(col("age", "Age", true)); // numeric, like the built-in tables' Age

    let mut rows: Vec<(String, String, TableRow)> = objects
        .iter()
        .map(|obj| {
            let name = str_at(obj, &["metadata", "name"]).unwrap_or_default().to_string();
            let ns = if r.namespaced {
                str_at(obj, &["metadata", "namespace"])
            } else {
                None
            };
            let mut cells = Vec::new();
            if with_namespace {
                cells.push(plain(ns.unwrap_or("—")));
            }
            cells.push(plain(name.clone()));
            for c in &printer {
                let text = match jsonpath::render(&c.json_path, obj) {
                    None => "—".to_string(),
                    Some(t) if t.is_empty() => "—".to_string(),
                    Some(t) if c.type_ == "date" => timestamp(&t).map(|t| age(Some(&t), now)).unwrap_or(t),
                    Some(t) => t,
                };
                cells.push(plain(text));
            }
            let created = str_at(obj, &["metadata", "creationTimestamp"]).and_then(timestamp);
            cells.push(plain(age(created.as_ref(), now)));
            let row = TableRow {
                node_id: custom_node_id(&r.group, &r.version, &r.kind, ns, &name),
                status: row_status(obj),
                cells,
            };
            (ns.unwrap_or_default().to_string(), name, row)
        })
        .collect();
    rows.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    Table {
        kind: Kind::Custom,
        columns,
        rows: rows.into_iter().map(|(_, _, row)| row).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{PrinterColumn, ResourceRef};
    use serde_json::json;

    fn kind(namespaced: bool, columns: &[(&str, &str, &str)]) -> CustomKind {
        CustomKind {
            resource: ResourceRef {
                group: "cert-manager.io".into(),
                version: "v1".into(),
                kind: "Certificate".into(),
                plural: "certificates".into(),
                namespaced,
            },
            columns: columns
                .iter()
                .map(|(n, p, t)| PrinterColumn {
                    name: n.to_string(),
                    json_path: p.to_string(),
                    type_: t.to_string(),
                })
                .collect(),
        }
    }

    fn cert(ns: &str, name: &str, ready: Option<&str>) -> serde_json::Value {
        let mut v = json!({
            "apiVersion": "cert-manager.io/v1", "kind": "Certificate",
            "metadata": { "name": name, "namespace": ns, "creationTimestamp": "2026-10-03T12:00:00Z" },
            "spec": { "secretName": format!("{name}-tls"), "renewBefore": 3 }
        });
        if let Some(r) = ready {
            v["status"] = json!({ "conditions": [{ "type": "Ready", "status": r }] });
        }
        v
    }

    fn now() -> jiff::Timestamp {
        "2026-10-06T12:00:00Z".parse().unwrap()
    }

    const COLUMNS: &[(&str, &str, &str)] = &[
        ("Ready", ".status.conditions[?(@.type==\"Ready\")].status", "string"),
        ("Secret", ".spec.secretName", "string"),
        ("Renew", ".spec.renewBefore", "integer"),
        ("Broken", ".spec..deep", "string"),
        ("Age", ".metadata.creationTimestamp", "date"),
    ];

    #[test]
    fn columns_are_name_printer_columns_and_age() {
        let t = table(&kind(true, COLUMNS), &[cert("shop", "web", Some("True"))], false, now());
        assert_eq!(t.kind, Kind::Custom);
        let labels: Vec<&str> = t.columns.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(
            labels,
            vec!["Name", "Ready", "Secret", "Renew", "Broken", "Age"],
            "the CRD's own Age is not doubled"
        );
        assert!(t.columns[3].numeric);
        let cells: Vec<&str> = t.rows[0].cells.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(cells, vec!["web", "True", "web-tls", "3", "—", "3d"]);
        assert_eq!(t.rows[0].node_id, "Custom/cert-manager.io/v1/Certificate/shop/web");
    }

    #[test]
    fn ready_condition_drives_row_status() {
        let t = table(
            &kind(true, &[]),
            &[cert("s", "a", Some("True")), cert("s", "b", Some("False")), cert("s", "c", None)],
            false,
            now(),
        );
        let status: Vec<Status> = t.rows.iter().map(|r| r.status).collect();
        assert_eq!(status, vec![Status::Ok, Status::Err, Status::Unknown]);
    }

    #[test]
    fn multi_namespace_scopes_get_a_leading_namespace_column_and_sort_by_it() {
        let t = table(
            &kind(true, &[]),
            &[cert("b", "x", None), cert("a", "y", None), cert("a", "b", None)],
            true,
            now(),
        );
        assert_eq!(t.columns[0].key, "namespace");
        let rows: Vec<(String, String)> = t.rows.iter().map(|r| (r.cells[0].text.clone(), r.cells[1].text.clone())).collect();
        assert_eq!(
            rows,
            vec![("a".into(), "b".into()), ("a".into(), "y".into()), ("b".into(), "x".into())]
        );
    }

    #[test]
    fn cluster_scoped_kinds_have_no_namespace_column_or_segment() {
        let mut issuer = cert("", "letsencrypt", None);
        issuer["metadata"].as_object_mut().unwrap().remove("namespace");
        let t = table(&kind(false, &[]), &[issuer], true, now());
        assert_eq!(t.columns[0].key, "name");
        assert_eq!(t.rows[0].node_id, "Custom/cert-manager.io/v1/Certificate//letsencrypt");
    }

    #[test]
    fn date_columns_show_an_age() {
        let mut c = cert("s", "a", None);
        c["status"] = json!({ "notAfter": "2026-10-06T11:00:00Z" });
        let t = table(&kind(true, &[("Expires", ".status.notAfter", "date")]), &[c], false, now());
        assert_eq!(t.rows[0].cells[1].text, "1h");
    }
}
