import type { Kind } from "./ipc/types";

/** Kinds that live outside any namespace: their RBAC and rows do not depend on the scope. */
export const CLUSTER_SCOPED: ReadonlySet<Kind> = new Set<Kind>(["PersistentVolume", "ClusterRole", "ClusterRoleBinding", "Node"]);
