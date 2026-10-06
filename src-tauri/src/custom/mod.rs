//! Custom resources: generalised ids, printer columns, tables and dynamic-API operations
//! (spec: docs/superpowers/specs/2026-10-06-crds-helm-design.md). Custom objects are never
//! kept in the `Store`; they are fetched when a table or a details panel needs them.

pub mod id;
pub mod jsonpath;
pub mod ops;
pub mod table;
pub mod watch;

use serde::{Deserialize, Serialize};

use crate::discovery::ResourceRef;
use crate::graph::rows::Table;

/// The rows of one custom kind's table: `list_custom`'s answer and the `custom_table` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomTable {
    pub resource: ResourceRef,
    pub table: Table,
    /// Why the table stopped being live, set only on the last `custom_table` event of a watch
    /// whose every stream ended for good: `"No access to <Kind> (RBAC)"`, `"<Kind> is no
    /// longer served"`, or the server's message (e.g. rejected credentials). Its rows are then
    /// empty. `null` otherwise, and always on `list_custom`'s answer.
    pub error: Option<String>,
}
