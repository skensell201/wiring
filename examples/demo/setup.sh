#!/usr/bin/env bash
# Deploy the demo workloads and RBAC identities, and add two restricted kubeconfig
# contexts (wiring-viewer, wiring-auditor) that reuse the current cluster.
# Usage: examples/demo/setup.sh [--with-metrics] [context]   (default context: docker-desktop)
#   --with-metrics  also install metrics-server (for the CPU / Memory columns), with
#                   --kubelet-insecure-tls as local clusters need.
#   -h, --help      show this usage.
set -euo pipefail
metrics_server_version=v0.9.0
usage() { echo "Usage: $0 [--with-metrics] [context]   (default context: docker-desktop)"; }
ctx=docker-desktop
with_metrics=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --with-metrics) with_metrics=1 ;;
    -*) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
    *) ctx="$arg" ;;
  esac
done
here="$(cd "$(dirname "$0")" && pwd)"

kubectl --context "$ctx" apply -f "$here/shop.yaml"
kubectl --context "$ctx" apply -f "$here/blog.yaml"
kubectl --context "$ctx" apply -f "$here/rbac.yaml"

cluster="$(kubectl config view -o jsonpath="{.contexts[?(@.name==\"$ctx\")].context.cluster}")"
add_ctx() { # name, namespace, service account
  local token
  token="$(kubectl --context "$ctx" -n "$2" create token "$3" --duration=168h)"
  kubectl config set-credentials "$1" --token="$token" >/dev/null
  kubectl config set-context "$1" --cluster="$cluster" --user="$1" --namespace="$2" >/dev/null
  echo "kubeconfig context '$1' added (SA $2/$3, token valid 7 days)"
}
add_ctx wiring-viewer shop viewer
add_ctx wiring-auditor default auditor

if [[ "$with_metrics" == 1 ]]; then
  kubectl --context "$ctx" apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/$metrics_server_version/components.yaml
  # Local clusters serve kubelet certificates metrics-server cannot verify; add the flag once.
  if ! kubectl --context "$ctx" -n kube-system get deploy metrics-server \
      -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q -- --kubelet-insecure-tls; then
    kubectl --context "$ctx" -n kube-system patch deployment metrics-server --type=json \
      -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
  fi
  kubectl --context "$ctx" -n kube-system rollout status deploy/metrics-server --timeout=180s
fi

echo "Waiting for the healthy workloads..."
kubectl --context "$ctx" -n shop rollout status deploy/web deploy/api deploy/workers --timeout=300s
kubectl --context "$ctx" -n blog rollout status deploy/blog --timeout=300s
kubectl --context "$ctx" -n shop get all
