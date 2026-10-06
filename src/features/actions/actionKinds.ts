import { KINDS, type GraphEdge, type GraphNode, type Kind, type NodeId } from "../../shared/ipc/types";
import { kindLabel } from "../graph/kindMeta";

/** Mirrors the backend's bound on a manual scale. */
export const MAX_REPLICAS = 10_000;
export const SCALE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["Deployment", "StatefulSet"]);
export const ROLLOUT_KINDS: ReadonlySet<Kind> = new Set<Kind>(["Deployment", "StatefulSet", "DaemonSet"]);
export const FORWARD_KINDS: ReadonlySet<Kind> = new Set<Kind>(["Pod", "Service", "Deployment", "StatefulSet", "DaemonSet"]);

/** Kinds with CPU / Memory usage (table columns, Overview rows); metrics samples refetch them. */
export const USAGE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["Pod", "Deployment", "StatefulSet", "DaemonSet"]);

export type ActionId = "scale" | "restart" | "rollback" | "forward" | "delete";

/** The Actions menu items for a kind, in menu order; everything can be deleted. */
export function actionsFor(kind: Kind | null): ActionId[] {
  const out: ActionId[] = [];
  if (kind && SCALE_KINDS.has(kind)) out.push("scale");
  if (kind && ROLLOUT_KINDS.has(kind)) out.push("restart", "rollback");
  if (kind && FORWARD_KINDS.has(kind)) out.push("forward");
  out.push("delete");
  return out;
}

export function kindOf(id: NodeId): Kind | null {
  const head = id.split("/")[0];
  return (KINDS as readonly string[]).includes(head) ? (head as Kind) : null;
}

/** "Deployment web" from `Deployment/ns/web`, for dialog titles. */
export function describeId(id: NodeId): string {
  const kind = kindOf(id);
  const name = id.split("/").pop() ?? id;
  return kind ? `${kindLabel(id, kind)} ${name}` : name;
}

/** The desired replica count from a workload node's first badge (`ready/desired`); 1 if unknown. */
export function desiredReplicas(node: GraphNode | undefined): number {
  const m = node?.badges[0]?.match(/^\d+\/(\d+)$/);
  return m ? Number(m[1]) : 1;
}

export interface HpaInfo { name: string; min: number | null; max: number | null }

/** The HPA whose `scales` edge targets `nodeId`; min/max come from its `min–max` badge. */
export function hpaFor(nodeId: NodeId, edges: Iterable<GraphEdge>, nodes: Map<NodeId, GraphNode>): HpaInfo | null {
  for (const e of edges) {
    if (e.relation !== "scales" || e.target !== nodeId) continue;
    const hpa = nodes.get(e.source);
    const m = hpa?.badges[0]?.match(/^(\d+)–(\d+)$/);
    return { name: hpa?.name ?? e.source.split("/").pop()!, min: m ? Number(m[1]) : null, max: m ? Number(m[2]) : null };
  }
  return null;
}
