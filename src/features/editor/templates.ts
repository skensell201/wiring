import { KINDS, type Kind } from "../../shared/ipc/types";

/** Kinds the Create dialog offers: every watched kind but the synthetic PodGroup and the cluster-level RBAC objects and Nodes. */
export type CreatableKind = Exclude<Kind, "PodGroup" | "ClusterRole" | "ClusterRoleBinding" | "Node">;
const NOT_CREATABLE = new Set<Kind>(["PodGroup", "ClusterRole", "ClusterRoleBinding", "Node"]);
export const isCreatable = (k: Kind): k is CreatableKind => !NOT_CREATABLE.has(k);
export const CREATABLE_KINDS: CreatableKind[] = KINDS.filter(isCreatable);

const PAUSE = "registry.k8s.io/pause:3.9";

const container = (indent: string) => `${indent}- name: app\n${indent}  image: ${PAUSE}\n`;

/** The body under `metadata`, per kind. `name` is the `my-…` placeholder the header carries. */
const BODIES: Record<CreatableKind, { apiVersion: string; name: string; body: string }> = {
  Pod: { apiVersion: "v1", name: "my-pod", body: `spec:\n  containers:\n${container("  ")}` },
  Deployment: {
    apiVersion: "apps/v1", name: "my-deployment",
    body: `spec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: my-app\n  template:\n    metadata:\n      labels:\n        app: my-app\n    spec:\n      containers:\n${container("      ")}`,
  },
  StatefulSet: {
    apiVersion: "apps/v1", name: "my-statefulset",
    body: `spec:\n  serviceName: my-statefulset\n  replicas: 1\n  selector:\n    matchLabels:\n      app: my-app\n  template:\n    metadata:\n      labels:\n        app: my-app\n    spec:\n      containers:\n${container("      ")}`,
  },
  DaemonSet: {
    apiVersion: "apps/v1", name: "my-daemonset",
    body: `spec:\n  selector:\n    matchLabels:\n      app: my-app\n  template:\n    metadata:\n      labels:\n        app: my-app\n    spec:\n      containers:\n${container("      ")}`,
  },
  ReplicaSet: {
    apiVersion: "apps/v1", name: "my-replicaset",
    body: `spec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: my-app\n  template:\n    metadata:\n      labels:\n        app: my-app\n    spec:\n      containers:\n${container("      ")}`,
  },
  Job: {
    apiVersion: "batch/v1", name: "my-job",
    body: `spec:\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n${container("      ")}`,
  },
  CronJob: {
    apiVersion: "batch/v1", name: "my-cronjob",
    body: `spec:\n  schedule: "*/5 * * * *"\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          restartPolicy: Never\n          containers:\n${container("          ")}`,
  },
  Service: {
    apiVersion: "v1", name: "my-service",
    body: "spec:\n  selector:\n    app: my-app\n  ports:\n    - port: 80\n      targetPort: 80\n",
  },
  Ingress: {
    apiVersion: "networking.k8s.io/v1", name: "my-ingress",
    body: "spec:\n  rules:\n    - http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: my-service\n                port:\n                  number: 80\n",
  },
  ConfigMap: { apiVersion: "v1", name: "my-configmap", body: "data:\n  key: value\n" },
  Secret: { apiVersion: "v1", name: "my-secret", body: "type: Opaque\nstringData:\n  key: value\n" },
  PersistentVolumeClaim: {
    apiVersion: "v1", name: "my-pvc",
    body: "spec:\n  accessModes:\n    - ReadWriteOnce\n  resources:\n    requests:\n      storage: 1Gi\n",
  },
  PersistentVolume: {
    apiVersion: "v1", name: "my-pv",
    body: "spec:\n  capacity:\n    storage: 1Gi\n  accessModes:\n    - ReadWriteOnce\n  hostPath:\n    path: /data/my-pv\n",
  },
  ServiceAccount: { apiVersion: "v1", name: "my-serviceaccount", body: "" },
  HorizontalPodAutoscaler: {
    apiVersion: "autoscaling/v2", name: "my-hpa",
    body: "spec:\n  scaleTargetRef:\n    apiVersion: apps/v1\n    kind: Deployment\n    name: my-deployment\n  minReplicas: 1\n  maxReplicas: 3\n  metrics:\n    - type: Resource\n      resource:\n        name: cpu\n        target:\n          type: Utilization\n          averageUtilization: 80\n",
  },
  NetworkPolicy: {
    apiVersion: "networking.k8s.io/v1", name: "my-networkpolicy",
    body: "spec:\n  podSelector:\n    matchLabels:\n      app: my-app\n  policyTypes:\n    - Ingress\n  ingress:\n    - from:\n        - podSelector:\n            matchLabels:\n              app: my-client\n",
  },
  Role: {
    apiVersion: "rbac.authorization.k8s.io/v1", name: "my-role",
    body: "rules:\n  - apiGroups: [\"\"]\n    resources: [\"pods\"]\n    verbs: [\"get\", \"list\"]\n",
  },
  RoleBinding: {
    apiVersion: "rbac.authorization.k8s.io/v1", name: "my-rolebinding",
    body: "roleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n  name: my-role\nsubjects:\n  - kind: ServiceAccount\n    name: default\n",
  },
};

/** A minimal, valid manifest for `kind` in `namespace` (ignored for the cluster-scoped PersistentVolume). */
export function template(kind: CreatableKind, namespace: string | null): string {
  const { apiVersion, name, body } = BODIES[kind];
  const ns = kind !== "PersistentVolume" && namespace !== null ? `  namespace: ${namespace}\n` : "";
  return `apiVersion: ${apiVersion}\nkind: ${kind}\nmetadata:\n  name: ${name}\n${ns}${body}`;
}
