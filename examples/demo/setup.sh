#!/usr/bin/env bash
# Deploy the demo workloads and RBAC identities, and add two restricted kubeconfig
# contexts (wiring-viewer, wiring-auditor) that reuse the current cluster.
# Usage: examples/demo/setup.sh [context]   (default: docker-desktop)
set -euo pipefail
ctx="${1:-docker-desktop}"
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

echo "Waiting for the healthy workloads..."
kubectl --context "$ctx" -n shop rollout status deploy/web deploy/api deploy/workers --timeout=300s
kubectl --context "$ctx" -n blog rollout status deploy/blog --timeout=300s
kubectl --context "$ctx" -n shop get all
