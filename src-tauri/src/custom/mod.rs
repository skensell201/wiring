//! Custom resources: generalised ids, printer columns, tables and dynamic-API operations
//! (spec: docs/superpowers/specs/2026-10-06-crds-helm-design.md). Custom objects are never
//! kept in the `Store`; they are fetched when a table or a details panel needs them.

pub mod id;
pub mod jsonpath;
