//! One watcher task per kind, feeding `StoreEvent`s into the reducer.

use futures::StreamExt;
use kube::api::Api;
use kube::runtime::watcher::{self, watcher, Event};
use kube::runtime::WatchStreamExt;
use kube::{Client, Resource};
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::error::{AppError, ErrorKind};
use crate::store::{Kind, Object, ObjectKey};

// `Object` is inherently large (full k8s-openapi structs); event volume is bounded by
// watcher throughput, so boxing here would only add indirection without a real benefit.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum StoreEvent {
    Applied(Object),
    Deleted(ObjectKey),
    /// Initial list for this kind is complete.
    InitDone(Kind),
    /// Watcher hit an error. `fatal` = permission denied, watcher stopped.
    Failed { kind: Kind, error: AppError, fatal: bool },
    /// Watcher produced data again after an error.
    Recovered(Kind),
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

pub fn app_error_from_kube(e: &kube::Error) -> AppError {
    match e {
        kube::Error::Api(resp) if resp.code == 401 => AppError::new(ErrorKind::Auth, resp.message.clone()),
        kube::Error::Api(resp) if resp.code == 403 => AppError::new(ErrorKind::Forbidden, resp.message.clone()),
        kube::Error::Api(resp) if resp.code == 404 => AppError::new(ErrorKind::NotFound, resp.message.clone()),
        kube::Error::Api(resp) => AppError::new(ErrorKind::Internal, resp.message.clone()),
        kube::Error::Auth(e) => AppError::new(ErrorKind::Auth, e.to_string()),
        kube::Error::HyperError(_) | kube::Error::Service(_) => AppError::new(ErrorKind::Network, e.to_string()),
        other => AppError::new(ErrorKind::Internal, other.to_string()),
    }
}

fn classify(kind: Kind, e: &watcher::Error) -> StoreEvent {
    let (error, fatal) = match e {
        watcher::Error::InitialListFailed(k) | watcher::Error::WatchStartFailed(k) | watcher::Error::WatchFailed(k) => {
            let app = app_error_from_kube(k);
            let fatal = app.kind == ErrorKind::Forbidden;
            (app, fatal)
        }
        watcher::Error::WatchError(resp) if resp.code == 403 => (AppError::new(ErrorKind::Forbidden, resp.message.clone()), true),
        other => (AppError::new(ErrorKind::Network, other.to_string()), false),
    };
    StoreEvent::Failed { kind, error, fatal }
}

/// Spawn a watcher over `api` (namespaced or cluster-wide — the caller decides).
pub fn spawn_watch<K: IntoObject>(api: Api<K>, tx: mpsc::Sender<StoreEvent>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let kind = K::KIND;
        let mut stream = watcher(api, watcher::Config::default()).default_backoff().boxed();
        let mut errored = false;
        while let Some(item) = stream.next().await {
            let ev = match item {
                Ok(Event::Init) => continue,
                Ok(Event::InitApply(obj)) | Ok(Event::Apply(obj)) => StoreEvent::Applied(obj.into_object()),
                Ok(Event::Delete(obj)) => StoreEvent::Deleted(obj.into_object().key()),
                Ok(Event::InitDone) => StoreEvent::InitDone(kind),
                Err(e) => {
                    tracing::warn!(?kind, error = %e, "watcher error");
                    let ev = classify(kind, &e);
                    let fatal = matches!(ev, StoreEvent::Failed { fatal: true, .. });
                    errored = true;
                    let _ = tx.send(ev).await;
                    if fatal {
                        return;
                    }
                    continue;
                }
            };
            if errored {
                errored = false;
                let _ = tx.send(StoreEvent::Recovered(kind)).await;
            }
            if tx.send(ev).await.is_err() {
                return; // reducer gone
            }
        }
    })
}

/// Start all 15 watchers for a namespace.
pub fn spawn_all(client: &Client, namespace: &str, tx: &mpsc::Sender<StoreEvent>) -> Vec<JoinHandle<()>> {
    use k8s_openapi::api::{apps::v1 as apps, autoscaling::v2 as autoscaling, batch::v1 as batch, core::v1 as core, networking::v1 as networking};
    macro_rules! ns {
        ($ty:ty) => { spawn_watch(Api::<$ty>::namespaced(client.clone(), namespace), tx.clone()) };
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
        spawn_watch(Api::<core::PersistentVolume>::all(client.clone()), tx.clone()),
        ns!(core::ServiceAccount),
        ns!(autoscaling::HorizontalPodAutoscaler),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forbidden_is_fatal_network_is_not() {
        let status = kube::core::Status { code: 403, message: "forbidden".into(), reason: "Forbidden".into(), ..Default::default() };
        let ev = classify(Kind::Secret, &watcher::Error::WatchError(Box::new(status)));
        assert!(matches!(ev, StoreEvent::Failed { kind: Kind::Secret, fatal: true, .. }));
        let ev = classify(Kind::Pod, &watcher::Error::NoResourceVersion);
        assert!(matches!(ev, StoreEvent::Failed { fatal: false, .. }));
    }
}
