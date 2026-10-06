//! The real `ExecConnector`: `kubectl exec -it` over the API server's websocket.

use futures::future::BoxFuture;
use futures::{FutureExt, SinkExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, TerminalSize};
use kube::Client;

use super::errors::start_error;
use super::session::{ExecConnector, Process};
use super::SHELL;

const PIPE_BUF: usize = 64 * 1024;

pub struct KubeExec {
    client: Client,
}

impl KubeExec {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

impl ExecConnector for KubeExec {
    fn open(&self, namespace: &str, pod: &str, container: &str, cols: u16, rows: u16) -> BoxFuture<'static, Result<Process, String>> {
        let api: Api<Pod> = Api::namespaced(self.client.clone(), namespace);
        let (pod, container) = (pod.to_string(), container.to_string());
        async move {
            // kube defaults to 1 KiB pipes; larger ones cut wakeups on pastes and bulk output.
            let params = AttachParams::interactive_tty()
                .container(container)
                .max_stdin_buf_size(PIPE_BUF)
                .max_stdout_buf_size(PIPE_BUF);
            let mut proc = api.exec(&pod, SHELL, &params).await.map_err(|e| start_error(&e))?;
            let stdin = proc.stdin().ok_or("the exec stream has no stdin")?;
            let stdout = proc.stdout().ok_or("the exec stream has no stdout")?;
            let status = proc.take_status().ok_or("the exec stream has no status channel")?;
            let mut sizes = proc.terminal_size();
            if let Some(tx) = sizes.as_mut() {
                let _ = tx.send(TerminalSize { width: cols, height: rows }).await;
            }
            Ok(Process {
                stdin: Box::new(stdin),
                stdout: Box::new(stdout),
                sizes,
                status: Box::pin(status),
                keep: Box::new(proc),
            })
        }
        .boxed()
    }
}
