//! Session-side bookkeeping for custom resources: the requests themselves live in
//! `custom::ops` and run without the session lock.
//!
//! Opening tables quickly (A, then B, then A again) races: lists finish in any order. Every
//! `list_custom` therefore takes a token under the lock when it starts ([`Session::begin_custom`])
//! and only starts its watch if the token is still current when its list is done
//! ([`Session::finish_custom`]). Starting another request, `stop_custom`, a scope switch and
//! teardown all bump the token, so a late list never starts a watch, and the watch they
//! replace is stopped right away. Each watch emits through its own closable emitter, closed
//! before the abort, so no event of a stopped watch reaches the frontend.

use std::future::Future;
use std::sync::Arc;

use kube::Client;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::emitter::{ClosableEmitter, Emitter};
use super::scope::NamespaceScope;
use super::Session;
use crate::custom::ops::{self, Source};
use crate::custom::CustomTable;
use crate::discovery::{CustomKind, ResourceRef};
use crate::error::{AppError, AppResult, ErrorKind};

/// The watcher behind the open custom table.
pub(crate) struct CustomWatch {
    resource: ResourceRef,
    task: JoinHandle<()>,
    emitter: ClosableEmitter,
}

/// What a `list_custom` took from the session when it started.
pub struct CustomRequest {
    generation: u64,
    token: u64,
    scope: NamespaceScope,
    fallback: Vec<String>,
    source: Arc<dyn Source>,
}

impl std::fmt::Debug for CustomRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CustomRequest")
            .field("generation", &self.generation)
            .field("token", &self.token)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

impl Session {
    pub fn client_handle(&self) -> Client {
        self.client.clone()
    }

    /// Distinguishes this session from the one before it: work started without the session
    /// lock (discovery, custom requests) only writes back into the same generation.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn scope(&self) -> Option<&NamespaceScope> {
        self.scope.as_ref()
    }

    pub fn custom_kinds(&self) -> Option<&[CustomKind]> {
        self.custom_kinds.as_deref()
    }

    pub fn set_custom_kinds(&mut self, kinds: Vec<CustomKind>) {
        self.custom_kinds = Some(kinds);
    }

    /// The kind whose table is being watched, if any.
    pub fn open_custom(&self) -> Option<&ResourceRef> {
        self.custom_watch.as_ref().map(|w| &w.resource)
    }

    /// Start a custom table request: stops the open custom watch and supersedes every
    /// request still in flight. Needs a selected scope.
    pub fn begin_custom(&mut self) -> AppResult<CustomRequest> {
        self.stop_custom();
        let scope = self
            .scope
            .clone()
            .ok_or_else(|| AppError::new(ErrorKind::Invalid, "select a namespace first"))?;
        Ok(CustomRequest {
            generation: self.generation,
            token: self.custom_token,
            scope,
            fallback: self.namespaces.clone().unwrap_or_default(),
            source: self.custom_source.clone(),
        })
    }

    /// Keep `kind`'s table live over `targets` (the streams that answered the list), unless
    /// `req` has been superseded; `false` when it was and nothing was started.
    pub fn finish_custom(&mut self, req: &CustomRequest, kind: &CustomKind, targets: Vec<Option<String>>) -> bool {
        let current = req.generation == self.generation && req.token == self.custom_token && self.scope.as_ref() == Some(&req.scope);
        if !current {
            return false;
        }
        let emitter = ClosableEmitter::new(Arc::new(self.ns_emitter.clone()));
        let task = crate::custom::watch::spawn(
            self.custom_source.clone(),
            kind.clone(),
            &targets,
            req.scope.is_multi(),
            Arc::new(emitter.clone()) as Arc<dyn Emitter>,
        );
        self.custom_watch = Some(CustomWatch {
            resource: kind.resource.clone(),
            task,
            emitter,
        });
        true
    }

    /// Stop the open custom watch (silenced before it is aborted) and supersede every
    /// request in flight.
    pub fn stop_custom(&mut self) {
        self.custom_token = self.custom_token.wrapping_add(1);
        if let Some(watch) = self.custom_watch.take() {
            watch.emitter.close();
            watch.task.abort();
        }
    }
}

/// `list_custom`: the rows of the kind `resolve` yields, in the current scope; the table then
/// stays live through `custom_table` events. The session lock is held only to begin and to
/// finish, never across `resolve` or the list. A superseded request still answers with its
/// own kind's rows (the frontend drops an answer for a table that is no longer open) but
/// starts no watch.
pub async fn list_custom<F, Fut>(sessions: &Mutex<Option<Session>>, resolve: F) -> AppResult<CustomTable>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = AppResult<CustomKind>>,
{
    let req = {
        let mut guard = sessions.lock().await;
        let session = guard.as_mut().ok_or_else(|| AppError::internal("not connected"))?;
        session.begin_custom()?
    };
    let kind = resolve().await?;
    let listed = ops::list(req.source.as_ref(), &kind.resource, &req.scope, &req.fallback).await?;
    let table = crate::custom::table::table(&kind, &listed.objects, req.scope.is_multi(), k8s_openapi::jiff::Timestamp::now());
    if let Some(session) = sessions.lock().await.as_mut() {
        session.finish_custom(&req, &kind, listed.targets);
    }
    Ok(CustomTable {
        resource: kind.resource,
        table,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::time::Duration;

    use kube::runtime::watcher::Event;
    use kube::{Client, Config};
    use serde_json::{json, Value};
    use tokio::sync::mpsc::UnboundedReceiver;
    use tokio::sync::Mutex;

    use super::super::emitter::{ChannelEmitter, OutEvent};
    use super::super::scope::NamespaceScope;
    use super::super::tests::offline_session;
    use super::super::Session;
    use super::*;
    use crate::custom::ops::fake::FakeSource;
    use crate::discovery::{CustomKind, ResourceRef};
    use crate::error::ErrorKind;

    fn kind_named(kind: &str) -> CustomKind {
        CustomKind {
            resource: ResourceRef {
                group: "x.io".into(),
                version: "v1".into(),
                kind: kind.into(),
                plural: format!("{}s", kind.to_lowercase()),
                namespaced: true,
            },
            columns: vec![],
        }
    }

    fn kind() -> CustomKind {
        kind_named("T")
    }

    fn obj(ns: &str, name: &str) -> Value {
        json!({ "metadata": { "namespace": ns, "name": name } })
    }

    /// A session on scope `a` whose custom requests go to `source`, and its event stream.
    fn session_with(source: &Arc<FakeSource>) -> (Session, UnboundedReceiver<OutEvent>) {
        let (emitter, rx) = ChannelEmitter::new();
        let client = Client::try_from(Config::new("https://127.0.0.1:1".parse().unwrap())).unwrap();
        let mut session = Session::new(client, Arc::new(emitter));
        session.custom_source = source.clone();
        session.scope = Some(NamespaceScope::single("a").unwrap());
        (session, rx)
    }

    fn resolve(kind: CustomKind) -> impl FnOnce() -> futures::future::Ready<crate::error::AppResult<CustomKind>> {
        move || futures::future::ready(Ok(kind))
    }

    fn watched(sessions: &Mutex<Option<Session>>) -> Option<String> {
        let guard = sessions.try_lock().unwrap();
        guard.as_ref().unwrap().open_custom().map(|r| r.kind.clone())
    }

    /// Wait (without sleeping) until `tx`'s watch task has been torn down.
    async fn closed(tx: &crate::custom::ops::fake::WatchTx) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !tx.is_closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the old watch was aborted");
    }

    #[tokio::test]
    async fn a_custom_watch_needs_a_scope_and_is_replaced_and_stopped() {
        let mut session = offline_session();
        assert_eq!(
            session.begin_custom().unwrap_err().kind,
            ErrorKind::Invalid,
            "no scope selected yet"
        );
        session.scope = Some(NamespaceScope::single("a").unwrap());
        let req = session.begin_custom().unwrap();
        assert!(session.finish_custom(&req, &kind(), vec![Some("a".into())]));
        assert!(session.custom_watch.is_some());
        let again = session.begin_custom().unwrap();
        assert!(session.custom_watch.is_none(), "starting another request stops the open watch");
        assert!(!session.finish_custom(&req, &kind(), vec![]), "the first request is stale now");
        session.stop_custom();
        assert!(
            !session.finish_custom(&again, &kind(), vec![]),
            "stop_custom invalidates pending requests"
        );
        assert!(session.custom_watch.is_none());
    }

    #[tokio::test]
    async fn generations_differ_between_sessions() {
        assert_ne!(offline_session().generation(), offline_session().generation());
    }

    #[tokio::test]
    async fn list_custom_returns_rows_and_watches_what_answered() {
        let source = Arc::new(FakeSource::default());
        source.answer("T", Some("a"), vec![obj("a", "x")]);
        let (session, mut rx) = session_with(&source);
        let sessions = Mutex::new(Some(session));
        let table = list_custom(&sessions, resolve(kind())).await.unwrap();
        assert_eq!(table.resource.kind, "T");
        assert_eq!(table.table.rows[0].node_id, "Custom/x.io/v1/T/a/x");
        assert_eq!(watched(&sessions).as_deref(), Some("T"));
        let watches = source.watches();
        assert_eq!(watches.len(), 1);
        assert_eq!(watches[0].1.as_deref(), Some("a"));

        // The watch's updates arrive as custom_table events and never touch the graph store.
        let tx = &watches[0].2;
        tx.unbounded_send(Ok(Event::Init)).unwrap();
        tx.unbounded_send(Ok(Event::InitApply(obj("a", "x")))).unwrap();
        tx.unbounded_send(Ok(Event::InitDone)).unwrap();
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap();
        assert!(matches!(ev, OutEvent::CustomTable(ref t) if t.table.rows.len() == 1), "{ev:?}");
        assert!(sessions.lock().await.as_ref().unwrap().shared.store().is_empty());
        sessions.lock().await.as_mut().unwrap().shutdown().await;
    }

    #[tokio::test]
    async fn rbac_denial_is_a_clear_error_and_starts_no_watch() {
        let source = Arc::new(FakeSource::default());
        source.fail("T", Some("a"), ErrorKind::Forbidden);
        let (session, _rx) = session_with(&source);
        let sessions = Mutex::new(Some(session));
        let err = list_custom(&sessions, resolve(kind())).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Forbidden);
        assert_eq!(err.message, "No access to T (RBAC)");
        assert_eq!(watched(&sessions), None);
        assert!(source.watches().is_empty());
    }

    #[tokio::test]
    async fn a_late_list_of_the_previous_table_never_replaces_the_open_one() {
        let source = Arc::new(FakeSource::default());
        let mut started = source.lists_started();
        let release_a = source.hold("A");
        let release_b = source.hold("B");
        let (session, _rx) = session_with(&source);
        let sessions = Arc::new(Mutex::new(Some(session)));

        let s = sessions.clone();
        let a = tokio::spawn(async move { list_custom(&s, resolve(kind_named("A"))).await });
        assert_eq!(started.recv().await.unwrap(), "A");
        let s = sessions.clone();
        let b = tokio::spawn(async move { list_custom(&s, resolve(kind_named("B"))).await });
        assert_eq!(started.recv().await.unwrap(), "B");

        release_b.send(()).unwrap();
        assert_eq!(b.await.unwrap().unwrap().resource.kind, "B");
        assert_eq!(watched(&sessions).as_deref(), Some("B"));

        release_a.send(()).unwrap();
        assert_eq!(a.await.unwrap().unwrap().resource.kind, "A", "the answer names its own kind");
        assert_eq!(watched(&sessions).as_deref(), Some("B"), "A's late list did not take over");
        assert!(source.watches_of("A").is_empty(), "no watch was ever started for A");
        assert!(!source.watches_of("B")[0].is_closed(), "B's watch still runs");
        sessions.lock().await.as_mut().unwrap().shutdown().await;
    }

    #[tokio::test]
    async fn stop_custom_while_a_list_is_in_flight_leaves_no_watch() {
        let source = Arc::new(FakeSource::default());
        let mut started = source.lists_started();
        let release = source.hold("A");
        let (session, _rx) = session_with(&source);
        let sessions = Arc::new(Mutex::new(Some(session)));
        let s = sessions.clone();
        let a = tokio::spawn(async move { list_custom(&s, resolve(kind_named("A"))).await });
        assert_eq!(started.recv().await.unwrap(), "A");
        sessions.lock().await.as_mut().unwrap().stop_custom();
        release.send(()).unwrap();
        a.await.unwrap().unwrap();
        assert_eq!(watched(&sessions), None);
        assert!(source.watches().is_empty());
    }

    #[tokio::test]
    async fn stop_custom_while_resolving_the_kind_leaves_no_watch() {
        let source = Arc::new(FakeSource::default());
        let (session, _rx) = session_with(&source);
        let sessions = Arc::new(Mutex::new(Some(session)));
        let (resolved_tx, resolved_rx) = tokio::sync::oneshot::channel::<()>();
        let (asked_tx, asked_rx) = tokio::sync::oneshot::channel::<()>();
        let s = sessions.clone();
        let a = tokio::spawn(async move {
            list_custom(&s, move || async move {
                asked_tx.send(()).unwrap();
                resolved_rx.await.unwrap();
                Ok(kind_named("A"))
            })
            .await
        });
        asked_rx.await.unwrap();
        sessions.lock().await.as_mut().unwrap().stop_custom();
        resolved_tx.send(()).unwrap();
        a.await.unwrap().unwrap();
        assert_eq!(watched(&sessions), None);
        assert!(source.watches().is_empty());
    }

    #[tokio::test]
    async fn a_scope_switch_while_a_list_is_in_flight_leaves_no_watch() {
        let source = Arc::new(FakeSource::default());
        let mut started = source.lists_started();
        let release = source.hold("A");
        let (session, _rx) = session_with(&source);
        let sessions = Arc::new(Mutex::new(Some(session)));
        let s = sessions.clone();
        let a = tokio::spawn(async move { list_custom(&s, resolve(kind_named("A"))).await });
        assert_eq!(started.recv().await.unwrap(), "A");
        // Switch away and back: the scope is equal again, but the request is still stale.
        for ns in ["b", "a"] {
            let scope = NamespaceScope::single(ns).unwrap();
            sessions
                .lock()
                .await
                .as_mut()
                .unwrap()
                .select_scope(scope, HashSet::new())
                .await
                .unwrap();
        }
        release.send(()).unwrap();
        a.await.unwrap().unwrap();
        assert_eq!(watched(&sessions), None);
        assert!(source.watches().is_empty());
        sessions.lock().await.as_mut().unwrap().shutdown().await;
    }

    #[tokio::test]
    async fn a_scope_switch_stops_the_open_watch() {
        let source = Arc::new(FakeSource::default());
        let (session, _rx) = session_with(&source);
        let sessions = Mutex::new(Some(session));
        list_custom(&sessions, resolve(kind())).await.unwrap();
        let tx = source.watches_of("T").remove(0);
        let scope = NamespaceScope::single("b").unwrap();
        sessions
            .lock()
            .await
            .as_mut()
            .unwrap()
            .select_scope(scope, HashSet::new())
            .await
            .unwrap();
        assert_eq!(watched(&sessions), None);
        closed(&tx).await;
        sessions.lock().await.as_mut().unwrap().shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn switching_a_then_b_then_a_never_shows_rows_of_an_old_watch() {
        let source = Arc::new(FakeSource::default());
        let (session, mut rx) = session_with(&source);
        let sessions = Mutex::new(Some(session));
        for k in ["A", "B", "A"] {
            list_custom(&sessions, resolve(kind_named(k))).await.unwrap();
        }
        let a = source.watches_of("A");
        let b = source.watches_of("B");
        assert_eq!((a.len(), b.len()), (2, 1));
        closed(&a[0]).await;
        closed(&b[0]).await;
        assert!(!a[1].is_closed());
        // Late items for the old watches have nowhere to go; only the open watch emits.
        let _ = a[0].unbounded_send(Ok(Event::Apply(obj("a", "stale-a"))));
        let _ = b[0].unbounded_send(Ok(Event::Apply(obj("a", "stale-b"))));
        a[1].unbounded_send(Ok(Event::Apply(obj("a", "fresh")))).unwrap();
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap().unwrap();
        let OutEvent::CustomTable(t) = ev else { panic!("{ev:?}") };
        assert_eq!(t.resource.kind, "A");
        let names: Vec<&str> = t.table.rows.iter().map(|r| r.cells[0].text.as_str()).collect();
        assert_eq!(names, vec!["fresh"]);
        assert!(tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_stopped_watch_emits_nothing_even_if_its_task_has_not_yet_unwound() {
        let source = Arc::new(FakeSource::default());
        let (session, mut rx) = session_with(&source);
        let sessions = Mutex::new(Some(session));
        list_custom(&sessions, resolve(kind())).await.unwrap();
        // On a multi-threaded runtime an aborted task can still be mid-emit; the watch's own
        // emitter is what silences it, so check that it is closed by `stop_custom`.
        let late = {
            let mut guard = sessions.lock().await;
            let session = guard.as_mut().unwrap();
            let late = session.custom_watch.as_ref().unwrap().emitter.clone();
            session.stop_custom();
            late
        };
        late.emit(OutEvent::CustomTable(CustomTable {
            resource: kind().resource,
            table: crate::custom::table::table(&kind(), &[], false, k8s_openapi::jiff::Timestamp::now()),
            error: None,
        }));
        assert!(tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.is_err());
    }
}
