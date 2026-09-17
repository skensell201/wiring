//! State shared between the reducer task and `Session` (get_object, expanded groups, etc).

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::graph::{build, diff, BuildOptions, Graph, GraphDelta, NodeId};
use crate::store::{Kind, Store};

/// Lock `m`, recovering the guarded value even if a previous holder panicked while holding it.
///
/// A panic in one reducer/graph-build code path must not permanently poison this lock and
/// wedge every later Tauri command (or reducer tick) that needs it — a stale-but-usable value
/// beats a thread that can never make progress again.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// State shared between the reducer task and `Session` (for get_object etc.).
#[derive(Default, Clone)]
pub struct Shared {
    store: Arc<Mutex<Store>>,
    graph: Arc<Mutex<Graph>>,
    expanded_groups: Arc<Mutex<HashSet<NodeId>>>,
    denied_kinds: Arc<Mutex<HashSet<Kind>>>,
}

impl Shared {
    pub fn store(&self) -> MutexGuard<'_, Store> {
        lock(&self.store)
    }

    pub fn graph(&self) -> MutexGuard<'_, Graph> {
        lock(&self.graph)
    }

    pub fn expanded_groups(&self) -> MutexGuard<'_, HashSet<NodeId>> {
        lock(&self.expanded_groups)
    }

    pub fn denied_kinds(&self) -> MutexGuard<'_, HashSet<Kind>> {
        lock(&self.denied_kinds)
    }

    fn build_options(&self) -> BuildOptions {
        BuildOptions { expanded_groups: self.expanded_groups().clone(), ..Default::default() }
    }

    /// Rebuild from the store; returns (new graph, delta vs previous).
    ///
    /// Locks the store, builds the graph, then locks the graph — never both at once — so this
    /// can never deadlock against another accessor taking the two locks in the same order.
    pub(crate) fn rebuild(&self) -> (Graph, GraphDelta) {
        let new = build(&self.store(), &self.build_options());
        let mut last = self.graph();
        let delta = diff(&last, &new);
        *last = new.clone();
        (new, delta)
    }
}
