//! The real connector: resolves pods with live API reads (forwards outlive the namespace the
//! store caches) and opens one `pods/portforward` stream per connection.

use std::collections::BTreeMap;

use futures::future::BoxFuture;
use futures::FutureExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
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

const FORBIDDEN: &str = "forbidden (pods/portforward)";

/// A refused websocket upgrade surfaces as `ProtocolSwitch(status)`, not as an API error.
fn failed(e: kube::Error) -> ConnectError {
    use kube::client::UpgradeConnectionError::ProtocolSwitch;
    match &e {
        kube::Error::UpgradeConnection(ProtocolSwitch(status)) if *status == http::StatusCode::FORBIDDEN => {
            ConnectError::Failed(FORBIDDEN.into())
        }
        kube::Error::UpgradeConnection(ProtocolSwitch(status)) => ConnectError::Failed(format!("port-forward refused: {status}")),
        kube::Error::Api(resp) if resp.code == 403 => ConnectError::Failed(FORBIDDEN.into()),
        _ => ConnectError::Failed(AppError::from(&e).message),
    }
}

/// The pod labels a workload selects; `matchExpressions` cannot be turned into a simple
/// label list, and silently ignoring them would report a misleading `noReadyPod`.
fn workload_labels(selector: LabelSelector) -> Result<BTreeMap<String, String>, ConnectError> {
    let labels = selector.match_labels.unwrap_or_default();
    if labels.is_empty() && selector.match_expressions.is_some_and(|e| !e.is_empty()) {
        return Err(ConnectError::Failed("unsupported selector (matchExpressions)".into()));
    }
    Ok(labels)
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
        Kind::Deployment => {
            let selector = Api::<Deployment>::namespaced(client, &t.namespace)
                .get(&t.name)
                .await
                .map_err(failed)?
                .spec
                .map(|s| s.selector)
                .unwrap_or_default();
            workload_labels(selector)?
        }
        Kind::StatefulSet => {
            let selector = Api::<StatefulSet>::namespaced(client, &t.namespace)
                .get(&t.name)
                .await
                .map_err(failed)?
                .spec
                .map(|s| s.selector)
                .unwrap_or_default();
            workload_labels(selector)?
        }
        Kind::DaemonSet => {
            let selector = Api::<DaemonSet>::namespaced(client, &t.namespace)
                .get(&t.name)
                .await
                .map_err(failed)?
                .spec
                .map(|s| s.selector)
                .unwrap_or_default();
            workload_labels(selector)?
        }
        other => return Err(ConnectError::Failed(format!("{} cannot be port-forwarded", other.as_str()))),
    };
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
            let error = pf.take_error(port).map(|f| Box::pin(f) as BoxFuture<'static, Option<String>>);
            Ok(Tunnel {
                error,
                stream: Box::new(stream),
                keep: Box::new(AbortOnDropPf(pf)),
            })
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelectorRequirement;

    fn msg(e: ConnectError) -> String {
        match e {
            ConnectError::Failed(m) => m,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_forbidden_upgrade_names_the_missing_permission() {
        let e = kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(http::StatusCode::FORBIDDEN));
        assert_eq!(msg(failed(e)), "forbidden (pods/portforward)");
        let api = kube::Error::Api(Box::new(kube::core::Status::failure("no", "Forbidden").with_code(403)));
        assert_eq!(msg(failed(api)), "forbidden (pods/portforward)");
        let other = kube::Error::UpgradeConnection(kube::client::UpgradeConnectionError::ProtocolSwitch(http::StatusCode::BAD_GATEWAY));
        assert!(msg(failed(other)).contains("502"));
    }

    #[test]
    fn match_expressions_only_selectors_are_reported() {
        let only_exprs = LabelSelector {
            match_expressions: Some(vec![LabelSelectorRequirement {
                key: "app".into(),
                operator: "Exists".into(),
                values: None,
            }]),
            ..Default::default()
        };
        assert_eq!(
            msg(workload_labels(only_exprs).unwrap_err()),
            "unsupported selector (matchExpressions)"
        );
        let labels = LabelSelector {
            match_labels: Some(BTreeMap::from([("app".to_string(), "x".to_string())])),
            ..Default::default()
        };
        assert_eq!(workload_labels(labels).unwrap().len(), 1);
        assert!(workload_labels(LabelSelector::default()).unwrap().is_empty());
    }
}
