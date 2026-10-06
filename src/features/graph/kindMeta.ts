import type { Kind } from "../../shared/ipc/types";

/** Short label + letter used in the node icon. Order = chip order. */
export const KIND_META: Record<Kind, { label: string; letter: string; short: string }> = {
  Ingress: { label: "Ingress", letter: "I", short: "Ingress" },
  Service: { label: "Service", letter: "S", short: "Service" },
  Deployment: { label: "Deployment", letter: "D", short: "Deploy" },
  StatefulSet: { label: "StatefulSet", letter: "SS", short: "STS" },
  DaemonSet: { label: "DaemonSet", letter: "DS", short: "DS" },
  ReplicaSet: { label: "ReplicaSet", letter: "RS", short: "RS" },
  Job: { label: "Job", letter: "J", short: "Job" },
  CronJob: { label: "CronJob", letter: "CJ", short: "CronJob" },
  Pod: { label: "Pod", letter: "P", short: "Pod" },
  PodGroup: { label: "Pods", letter: "P", short: "Pods" },
  ConfigMap: { label: "ConfigMap", letter: "CM", short: "ConfigMap" },
  Secret: { label: "Secret", letter: "SE", short: "Secret" },
  PersistentVolumeClaim: { label: "PersistentVolumeClaim", letter: "PVC", short: "PVC" },
  PersistentVolume: { label: "PersistentVolume", letter: "PV", short: "PV" },
  ServiceAccount: { label: "ServiceAccount", letter: "SA", short: "SA" },
  HorizontalPodAutoscaler: { label: "HorizontalPodAutoscaler", letter: "HPA", short: "HPA" },
  NetworkPolicy: { label: "NetworkPolicy", letter: "NP", short: "NetPol" },
  Role: { label: "Role", letter: "R", short: "Role" },
  RoleBinding: { label: "RoleBinding", letter: "RB", short: "RoleBinding" },
  ClusterRole: { label: "ClusterRole", letter: "CR", short: "ClusterRole" },
  ClusterRoleBinding: { label: "ClusterRoleBinding", letter: "CRB", short: "CRB" },
  Node: { label: "Node", letter: "N", short: "Node" },
};

/** Kinds shown as filter chips (PodGroup follows Pod). */
export const CHIP_KINDS: Kind[] = [
  "Ingress", "Service", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod",
  "ConfigMap", "Secret", "PersistentVolumeClaim", "PersistentVolume", "ServiceAccount", "HorizontalPodAutoscaler",
  "NetworkPolicy", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "Node",
];

/** Workload kinds get the gradient icon; everything else a muted one. */
export const GRADIENT_KINDS = new Set<Kind>(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Ingress"]);
