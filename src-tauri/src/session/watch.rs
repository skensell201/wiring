//! One watcher task per watch stream (a kind in a namespace, or cluster-wide), feeding `StoreEvent`s into the reducer.

use std::future::Future;

use futures::{Stream, StreamExt};
use kube::api::Api;
use kube::runtime::watcher::{self, watcher, Event};
use kube::runtime::WatchStreamExt;
use kube::{Client, Resource};
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::scope::StreamId;
use crate::error::{AppError, ErrorKind};
use crate::store::{Kind, Object, ObjectKey};

// `Object` is inherently large (full k8s-openapi structs); event volume is bounded by
// watcher throughput, so boxing here would only add indirection without a real benefit.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum StoreEvent {
    Applied(Object),
    Deleted(ObjectKey),
    /// The watch stream restarted (e.g. after a 410 Gone re-list). The reducer should
    /// mark-and-sweep: objects of this stream not re-applied before its next `InitDone`
    /// were deleted during the outage.
    Restarted(StreamId),
    /// Initial list for this stream is complete.
    InitDone(StreamId),
    /// Watcher hit an error. `fatal` = permission denied (or a panicked watcher task), stopped.
    Failed {
        stream: StreamId,
        error: AppError,
        fatal: bool,
    },
    /// Watcher produced data again after an error.
    Recovered(StreamId),
    /// The cluster-wide watch of `kind` was forbidden; it now runs per namespace over
    /// `namespaces` (empty: nowhere, the kind is denied).
    FellBack {
        kind: Kind,
        namespaces: Vec<String>,
    },
}

/// Typed k8s-openapi resource -> `Object`.
pub trait IntoObject: Resource<DynamicType = ()> + Clone + DeserializeOwned + std::fmt::Debug + Send + Sync + 'static {
    const KIND: Kind;
    fn into_object(self) -> Object;
}

macro_rules! into_object {
    ($($ty:ty => $variant:ident),* $(,)?) => {
        $(impl IntoObject for $ty {
            const KIND: Kind = Kind::$variant;
            fn into_object(self) -> Object { Object::$variant(self) }
        })*
    };
}

into_object! {
    k8s_openapi::api::apps::v1::Deployment => Deployment,
    k8s_openapi::api::apps::v1::StatefulSet => StatefulSet,
    k8s_openapi::api::apps::v1::DaemonSet => DaemonSet,
    k8s_openapi::api::apps::v1::ReplicaSet => ReplicaSet,
    k8s_openapi::api::batch::v1::Job => Job,
    k8s_openapi::api::batch::v1::CronJob => CronJob,
    k8s_openapi::api::core::v1::Pod => Pod,
    k8s_openapi::api::core::v1::Service => Service,
    k8s_openapi::api::networking::v1::Ingress => Ingress,
    k8s_openapi::api::core::v1::ConfigMap => ConfigMap,
    k8s_openapi::api::core::v1::Secret => Secret,
    k8s_openapi::api::core::v1::PersistentVolumeClaim => PersistentVolumeClaim,
    k8s_openapi::api::core::v1::PersistentVolume => PersistentVolume,
    k8s_openapi::api::core::v1::ServiceAccount => ServiceAccount,
    k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler => HorizontalPodAutoscaler,
}

/// Decide whether a watcher error ends the watcher for good (spec §8).
///
/// - 403: no RBAC for this kind — it is dropped and reported via `denied_kinds`.
/// - 401: credentials are rejected; retrying with the same client cannot succeed.
/// - 404 on the initial list: the API group is not served by this cluster (e.g. no
///   `autoscaling/v2`); a 404 mid-watch is a re-list trigger, not a missing API.
///
/// Everything else is transient and left to the watcher's own backoff.
fn classify(stream: StreamId, e: &watcher::Error) -> StoreEvent {
    let (error, fatal) = match e {
        watcher::Error::InitialListFailed(k) | watcher::Error::WatchStartFailed(k) | watcher::Error::WatchFailed(k) => {
            let app = AppError::from(k);
            let fatal = match app.kind {
                ErrorKind::Forbidden | ErrorKind::Auth => true,
                ErrorKind::NotFound => matches!(e, watcher::Error::InitialListFailed(_)),
                _ => false,
            };
            (app, fatal)
        }
        watcher::Error::WatchError(resp) => {
            let app = crate::error::from_status(resp.code, &resp.message);
            let fatal = matches!(app.kind, ErrorKind::Forbidden | ErrorKind::Auth);
            (app, fatal)
        }
        other => (AppError::new(ErrorKind::Network, other.to_string()), false),
    };
    StoreEvent::Failed { stream, error, fatal }
}

/// How `translate` ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum End {
    /// The stream finished, the reducer is gone, or a fatal error was reported.
    Finished,
    /// A forbidden error, held back because the caller asked to fall back instead of reporting it.
    Forbidden,
}

/// Translate a raw watcher stream into `StoreEvent`s, sending them on `tx`.
///
/// Cluster-free by construction (generic over the stream), so it is unit-tested without
/// a real `Api`/`watcher()`. Stops when a fatal error is classified, or when the receiver
/// (reducer) is gone. With `hold_forbidden`, a 403 is not reported: translation stops and
/// returns `End::Forbidden` so the caller can fall back to narrower streams.
async fn translate<K: IntoObject, S>(stream_id: StreamId, mut stream: S, tx: mpsc::Sender<StoreEvent>, hold_forbidden: bool) -> End
where
    S: Stream<Item = Result<Event<K>, watcher::Error>> + Unpin,
{
    let mut errored = false;
    while let Some(item) = stream.next().await {
        match item {
            Ok(ok_event) => {
                if errored {
                    errored = false;
                    if tx.send(StoreEvent::Recovered(stream_id.clone())).await.is_err() {
                        return End::Finished; // reducer gone
                    }
                }
                let ev = match ok_event {
                    Event::Init => StoreEvent::Restarted(stream_id.clone()),
                    Event::InitApply(obj) | Event::Apply(obj) => StoreEvent::Applied(obj.into_object()),
                    Event::Delete(obj) => StoreEvent::Deleted(obj.into_object().key()),
                    Event::InitDone => StoreEvent::InitDone(stream_id.clone()),
                };
                if tx.send(ev).await.is_err() {
                    return End::Finished; // reducer gone
                }
            }
            Err(e) => {
                tracing::warn!(kind = ?stream_id.kind, namespace = ?stream_id.namespace, error = %e, "watcher error");
                let ev = classify(stream_id.clone(), &e);
                let (fatal, forbidden) = match &ev {
                    StoreEvent::Failed { fatal, error, .. } => (*fatal, *fatal && error.kind == ErrorKind::Forbidden),
                    _ => (false, false),
                };
                if hold_forbidden && forbidden {
                    return End::Forbidden;
                }
                errored = true;
                if tx.send(ev).await.is_err() {
                    return End::Finished; // reducer gone
                }
                if fatal {
                    return End::Finished;
                }
            }
        }
    }
    End::Finished
}

/// Aborts the wrapped task when dropped, so cancelling an outer supervising task also
/// tears down the inner task it spawned.
pub(crate) struct AbortOnDrop(pub(crate) JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Run `fut` on its own task, catch a panic, and report it as a fatal `StoreEvent::Failed`
/// instead of silently losing the watcher (spec §8).
///
/// Aborting the returned `JoinHandle` (what `Session` does on teardown) also aborts the
/// inner task via `AbortOnDrop`.
fn spawn_supervised(stream: StreamId, fut: impl Future<Output = ()> + Send + 'static, tx: mpsc::Sender<StoreEvent>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut inner = AbortOnDrop(tokio::spawn(fut));
        if let Err(join_err) = (&mut inner.0).await {
            if join_err.is_panic() {
                tracing::error!(kind = ?stream.kind, namespace = ?stream.namespace, error = %join_err, "watcher task panicked");
                let error = AppError::internal(format!("{} watcher panicked", stream.kind.as_str()));
                let _ = tx
                    .send(StoreEvent::Failed {
                        stream,
                        error,
                        fatal: true,
                    })
                    .await;
            }
        }
    })
}

/// Spawn a watcher over `api` (namespaced or cluster-wide — the caller decides, and names
/// the matching `stream_id`).
pub fn spawn_watch<K: IntoObject>(api: Api<K>, stream_id: StreamId, tx: mpsc::Sender<StoreEvent>) -> JoinHandle<()> {
    let stream = watcher(api, watcher::Config::default()).default_backoff().boxed();
    let fut = {
        let (stream_id, tx) = (stream_id.clone(), tx.clone());
        async move {
            translate(stream_id, stream, tx, false).await;
        }
    };
    spawn_supervised(stream_id, fut, tx)
}

/// Start all 15 watchers for a namespace.
pub fn spawn_all(client: &Client, namespace: &str, tx: &mpsc::Sender<StoreEvent>) -> Vec<JoinHandle<()>> {
    use k8s_openapi::api::{
        apps::v1 as apps, autoscaling::v2 as autoscaling, batch::v1 as batch, core::v1 as core, networking::v1 as networking,
    };
    macro_rules! ns {
        ($ty:ty) => {
            spawn_watch(
                Api::<$ty>::namespaced(client.clone(), namespace),
                StreamId::namespaced(<$ty as IntoObject>::KIND, namespace),
                tx.clone(),
            )
        };
    }
    vec![
        ns!(apps::Deployment),
        ns!(apps::StatefulSet),
        ns!(apps::DaemonSet),
        ns!(apps::ReplicaSet),
        ns!(batch::Job),
        ns!(batch::CronJob),
        ns!(core::Pod),
        ns!(core::Service),
        ns!(networking::Ingress),
        ns!(core::ConfigMap),
        ns!(core::Secret),
        ns!(core::PersistentVolumeClaim),
        spawn_watch(
            Api::<core::PersistentVolume>::all(client.clone()),
            StreamId::cluster(Kind::PersistentVolume),
            tx.clone(),
        ),
        ns!(core::ServiceAccount),
        ns!(autoscaling::HorizontalPodAutoscaler),
    ]
}

#[cfg(test)]
mod tests {
    use k8s_openapi::api::core::v1::{PersistentVolume, Pod};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

    use super::*;

    fn pod(name: &str) -> Pod {
        Pod {
            metadata: ObjectMeta {
                name: Some(name.into()),
                namespace: Some("n".into()),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    fn status(code: u16) -> kube::core::Status {
        kube::core::Status {
            code,
            message: format!("status {code}"),
            reason: "reason".into(),
            ..Default::default()
        }
    }

    fn api_error(code: u16) -> kube::Error {
        kube::Error::Api(Box::new(status(code)))
    }

    fn failed(ev: StoreEvent) -> (ErrorKind, bool) {
        match ev {
            StoreEvent::Failed { error, fatal, .. } => (error.kind, fatal),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn forbidden_is_fatal_network_is_not() {
        let ev = classify(Kind::Secret.into(), &watcher::Error::WatchError(Box::new(status(403))));
        assert!(matches!(
            ev,
            StoreEvent::Failed {
                stream,
                fatal: true,
                ..
            } if stream.kind == Kind::Secret
        ));
        assert_eq!(
            failed(classify(Kind::Secret.into(), &watcher::Error::InitialListFailed(api_error(403)))),
            (ErrorKind::Forbidden, true)
        );
        let ev = classify(Kind::Pod.into(), &watcher::Error::NoResourceVersion);
        assert!(matches!(ev, StoreEvent::Failed { fatal: false, .. }));
    }

    #[test]
    fn not_found_on_initial_list_is_fatal_but_transient_elsewhere() {
        // The API group is not served at all (e.g. no autoscaling/v2): give up on the kind.
        assert_eq!(
            failed(classify(
                Kind::HorizontalPodAutoscaler.into(),
                &watcher::Error::InitialListFailed(api_error(404))
            )),
            (ErrorKind::NotFound, true)
        );
        // A 404 mid-watch is a re-list trigger, not a missing API.
        assert_eq!(
            failed(classify(Kind::Pod.into(), &watcher::Error::WatchFailed(api_error(404)))),
            (ErrorKind::NotFound, false)
        );
        assert_eq!(
            failed(classify(Kind::Pod.into(), &watcher::Error::WatchStartFailed(api_error(404)))),
            (ErrorKind::NotFound, false)
        );
    }

    #[test]
    fn unauthorized_is_always_fatal() {
        assert_eq!(
            failed(classify(Kind::Pod.into(), &watcher::Error::InitialListFailed(api_error(401)))),
            (ErrorKind::Auth, true)
        );
        assert_eq!(
            failed(classify(Kind::Pod.into(), &watcher::Error::WatchStartFailed(api_error(401)))),
            (ErrorKind::Auth, true)
        );
        assert_eq!(
            failed(classify(Kind::Pod.into(), &watcher::Error::WatchFailed(api_error(401)))),
            (ErrorKind::Auth, true)
        );
        assert_eq!(
            failed(classify(Kind::Pod.into(), &watcher::Error::WatchError(Box::new(status(401))))),
            (ErrorKind::Auth, true)
        );
    }

    #[test]
    fn server_errors_are_transient() {
        assert_eq!(
            failed(classify(Kind::Pod.into(), &watcher::Error::InitialListFailed(api_error(500)))),
            (ErrorKind::Internal, false)
        );
        assert_eq!(
            failed(classify(Kind::Pod.into(), &watcher::Error::WatchError(Box::new(status(500))))),
            (ErrorKind::Internal, false)
        );
    }

    #[tokio::test]
    async fn translate_maps_watcher_events() {
        let pod_a = pod("a");
        let pod_b = pod("b");
        let events: Vec<Result<Event<Pod>, watcher::Error>> = vec![
            Ok(Event::Init),
            Ok(Event::InitApply(pod_a.clone())),
            Ok(Event::InitDone),
            Err(watcher::Error::NoResourceVersion),
            Ok(Event::Apply(pod_b.clone())),
            Ok(Event::Delete(pod_a.clone())),
        ];
        let stream = futures::stream::iter(events);
        let (tx, mut rx) = mpsc::channel(16);
        translate::<Pod, _>(Kind::Pod.into(), stream, tx, false).await;

        let mut received = Vec::new();
        while let Some(ev) = rx.recv().await {
            received.push(ev);
        }

        assert_eq!(received.len(), 7);
        assert!(matches!(&received[0], StoreEvent::Restarted(s) if s.kind == Kind::Pod));
        assert!(matches!(&received[1], StoreEvent::Applied(obj) if obj.name() == "a"));
        assert!(matches!(&received[2], StoreEvent::InitDone(s) if s.kind == Kind::Pod));
        assert!(matches!(
            &received[3],
            StoreEvent::Failed {
                stream,
                fatal: false,
                ..
            } if stream.kind == Kind::Pod
        ));
        assert!(matches!(&received[4], StoreEvent::Recovered(s) if s.kind == Kind::Pod));
        assert!(matches!(&received[5], StoreEvent::Applied(obj) if obj.name() == "b"));
        assert!(matches!(&received[6], StoreEvent::Deleted(key) if key.name == "a"));
    }

    #[tokio::test]
    async fn fatal_error_stops_translation() {
        let status = kube::core::Status {
            code: 403,
            message: "forbidden".into(),
            reason: "Forbidden".into(),
            ..Default::default()
        };
        let events: Vec<Result<Event<Pod>, watcher::Error>> = vec![Err(watcher::Error::WatchError(Box::new(status))), Ok(Event::InitDone)];
        let stream = futures::stream::iter(events);
        let (tx, mut rx) = mpsc::channel(16);
        translate::<Pod, _>(Kind::Pod.into(), stream, tx, false).await;

        let ev = rx.recv().await.expect("expected a Failed event");
        assert!(matches!(
            ev,
            StoreEvent::Failed {
                stream,
                fatal: true,
                ..
            } if stream.kind == Kind::Pod
        ));
        assert!(rx.recv().await.is_none(), "channel should be closed after the fatal error");
    }

    #[tokio::test]
    async fn panicking_watcher_reports_fatal_failure() {
        let (tx, mut rx) = mpsc::channel(16);
        let handle = spawn_supervised(Kind::Pod.into(), async { panic!("boom") }, tx);
        handle.await.expect("supervising task itself should not panic");

        match rx.recv().await.expect("expected a Failed event") {
            StoreEvent::Failed { stream, fatal, error } => {
                assert_eq!(stream.kind, Kind::Pod);
                assert!(fatal);
                assert_eq!(error.kind, ErrorKind::Internal);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_held_forbidden_error_ends_without_being_reported() {
        let events: Vec<Result<Event<Pod>, watcher::Error>> = vec![Ok(Event::Init), Err(watcher::Error::InitialListFailed(api_error(403)))];
        let (tx, mut rx) = mpsc::channel(16);
        let end = translate::<Pod, _>(Kind::Pod.into(), futures::stream::iter(events), tx, true).await;
        assert_eq!(end, End::Forbidden);
        assert!(matches!(rx.recv().await, Some(StoreEvent::Restarted(_))));
        assert!(rx.recv().await.is_none(), "the 403 is not reported when held");
    }

    #[tokio::test]
    async fn a_held_forbidden_still_reports_other_errors() {
        // Only a 403 is held back: a 401 or a transient error is reported as usual.
        let events: Vec<Result<Event<Pod>, watcher::Error>> = vec![
            Err(watcher::Error::NoResourceVersion),
            Ok(Event::InitDone),
            Err(watcher::Error::InitialListFailed(api_error(401))),
        ];
        let (tx, mut rx) = mpsc::channel(16);
        let end = translate::<Pod, _>(Kind::Pod.into(), futures::stream::iter(events), tx, true).await;
        assert_eq!(end, End::Finished);
        assert!(matches!(rx.recv().await, Some(StoreEvent::Failed { fatal: false, .. })));
        assert!(matches!(rx.recv().await, Some(StoreEvent::Recovered(_))));
        assert!(matches!(rx.recv().await, Some(StoreEvent::InitDone(_))));
        assert!(matches!(rx.recv().await, Some(StoreEvent::Failed { fatal: true, .. })));
        assert!(rx.recv().await.is_none());
    }

    #[test]
    fn into_object_round_trip() {
        let pod = pod("p");
        assert_eq!(pod.into_object().kind(), <Pod as IntoObject>::KIND);

        let pv = PersistentVolume {
            metadata: ObjectMeta {
                name: Some("v".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(pv.into_object().kind(), <PersistentVolume as IntoObject>::KIND);
    }
}
