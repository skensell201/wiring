import type { Kind } from "../../shared/ipc/types";

export interface Section { id: string; label: string; kinds: Kind[] }

/** Resource categories in the Navigator, in display order. */
export const SECTIONS: Section[] = [
  { id: "workloads", label: "Workloads", kinds: ["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"] },
  { id: "config", label: "Config", kinds: ["ConfigMap", "Secret", "HorizontalPodAutoscaler"] },
  { id: "network", label: "Network", kinds: ["Service", "Ingress", "NetworkPolicy"] },
  { id: "storage", label: "Storage", kinds: ["PersistentVolumeClaim", "PersistentVolume"] },
  { id: "access", label: "Access Control", kinds: ["ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"] },
  { id: "cluster", label: "Cluster", kinds: ["Node"] },
];

/** Row labels in the tree and table headings. */
export const KIND_PLURAL: Record<Kind, string> = {
  Pod: "Pods", Deployment: "Deployments", StatefulSet: "Stateful Sets", DaemonSet: "Daemon Sets", ReplicaSet: "Replica Sets",
  Job: "Jobs", CronJob: "Cron Jobs", ConfigMap: "Config Maps", Secret: "Secrets", HorizontalPodAutoscaler: "HPAs",
  Service: "Services", Ingress: "Ingresses", PersistentVolumeClaim: "Persistent Volume Claims", PersistentVolume: "Persistent Volumes",
  ServiceAccount: "Service Accounts", PodGroup: "Pods", Custom: "Custom Resources",
  NetworkPolicy: "Network Policies", Role: "Roles", RoleBinding: "Role Bindings", ClusterRole: "Cluster Roles",
  ClusterRoleBinding: "Cluster Role Bindings", Node: "Nodes",
};

export function sectionOf(kind: Kind): Section | undefined {
  return SECTIONS.find((s) => s.kinds.includes(kind));
}
