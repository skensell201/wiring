//! The real connector: resolves pods with live API reads (forwards outlive the namespace the
//! store caches) and opens one `pods/portforward` stream per connection.

use std::collections::BTreeMap;

use futures::future::BoxFuture;
use futures::FutureExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{Pod, Service};
use kube::api::{Api, ListParams, Portforwarder};
use kube::Client;

use crate::error::AppError;
use crate::store::Kind;

use super::manager::{ConnectError, Connector, Tunnel};
use super::resolve::{pick_pod, selector_string, service_target_port, serving};
use super::ForwardTarget;

pub struct KubeConnector {
    client: Client,
}

impl KubeConnector {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

fn failed(e: kube::Error) -> ConnectError {
    ConnectError::Failed(AppError::from(&e).message)
}

/// Aborts kube's background forwarding task with the tunnel.
struct AbortOnDropPf(Portforwarder);

impl Drop for AbortOnDropPf {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn list_pods(pods: &Api<Pod>, labels: &BTreeMap<String, String>) -> Result<Vec<Pod>, ConnectError> {
    let Some(selector) = selector_string(labels) else {
        return Ok(vec![]);
    };
    Ok(pods.list(&ListParams::default().labels(&selector)).await.map_err(failed)?.items)
}

async fn resolve_live(client: Client, t: ForwardTarget, remote_port: u16) -> Result<(String, u16), ConnectError> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), &t.namespace);
    let labels = match t.kind {
        Kind::Pod => {
            let Some(pod) = pods.get_opt(&t.name).await.map_err(failed)? else {
                return Err(ConnectError::PodGone);
            };
            return if serving(&pod) {
                Ok((t.name, remote_port))
            } else {
                Err(ConnectError::NoReadyPod)
            };
        }
        Kind::Service => {
            let svc = Api::<Service>::namespaced(client, &t.namespace)
                .get(&t.name)
                .await
                .map_err(failed)?;
            let labels = svc.spec.as_ref().and_then(|s| s.selector.clone()).unwrap_or_default();
            let list = list_pods(&pods, &labels).await?;
            let pod = pick_pod(&list).ok_or(ConnectError::NoReadyPod)?;
            let port = service_target_port(&svc, remote_port, pod).map_err(ConnectError::Failed)?;
            return Ok((pod.metadata.name.clone().unwrap_or_default(), port));
        }
        // Like `kubectl port-forward deploy/x`: the workload's selector picks the pods.
        Kind::Deployment => Api::<Deployment>::namespaced(client, &t.namespace)
            .get(&t.name)
            .await
            .map_err(failed)?
            .spec
            .and_then(|s| s.selector.match_labels),
        Kind::StatefulSet => Api::<StatefulSet>::namespaced(client, &t.namespace)
            .get(&t.name)
            .await
            .map_err(failed)?
            .spec
            .and_then(|s| s.selector.match_labels),
        Kind::DaemonSet => Api::<DaemonSet>::namespaced(client, &t.namespace)
            .get(&t.name)
            .await
            .map_err(failed)?
            .spec
            .and_then(|s| s.selector.match_labels),
        other => return Err(ConnectError::Failed(format!("{} cannot be port-forwarded", other.as_str()))),
    }
    .unwrap_or_default();
    let list = list_pods(&pods, &labels).await?;
    let pod = pick_pod(&list).ok_or(ConnectError::NoReadyPod)?;
    Ok((pod.metadata.name.clone().unwrap_or_default(), remote_port))
}

impl Connector for KubeConnector {
    fn resolve(&self, target: &ForwardTarget, remote_port: u16) -> BoxFuture<'static, Result<(String, u16), ConnectError>> {
        resolve_live(self.client.clone(), target.clone(), remote_port).boxed()
    }

    fn open(&self, namespace: &str, pod: &str, port: u16) -> BoxFuture<'static, Result<Tunnel, ConnectError>> {
        let api: Api<Pod> = Api::namespaced(self.client.clone(), namespace);
        let pod = pod.to_string();
        async move {
            let mut pf = api.portforward(&pod, &[port]).await.map_err(failed)?;
            let stream = pf
                .take_stream(port)
                .ok_or_else(|| ConnectError::Failed(format!("no stream for port {port}")))?;
            Ok(Tunnel {
                stream: Box::new(stream),
                keep: Box::new(AbortOnDropPf(pf)),
            })
        }
        .boxed()
    }
}
