import type { GraphEdge, GraphNode, Kind, NodeId } from "../../shared/ipc/types";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 64;
export const COLUMN_GAP = 96;
export const ROW_GAP = 24;

export interface Position { x: number; y: number }

const LAYERS: Record<Kind, number> = {
  HorizontalPodAutoscaler: 0,
  Ingress: 1,
  Service: 2,
  Deployment: 3, StatefulSet: 3, DaemonSet: 3, CronJob: 3,
  ReplicaSet: 4, Job: 4,
  ConfigMap: 5, Secret: 5, PersistentVolumeClaim: 5, PersistentVolume: 5, ServiceAccount: 5,
  Pod: 6, PodGroup: 6,
};

export function layerOf(kind: Kind): number {
  return LAYERS[kind];
}

/**
 * Deterministic layered layout: one column per (non-empty) layer, rows ordered by
 * the barycenter of already-placed neighbours, ties broken by id, orphans last.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[]): Map<NodeId, Position> {
  const ids = new Set(nodes.map((n) => n.id));
  const preds = new Map<NodeId, NodeId[]>();
  const succs = new Map<NodeId, NodeId[]>();
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    (preds.get(e.target) ?? preds.set(e.target, []).get(e.target)!).push(e.source);
    (succs.get(e.source) ?? succs.set(e.source, []).get(e.source)!).push(e.target);
  }

  // Group by layer, drop empty layers.
  const byLayer = new Map<number, GraphNode[]>();
  for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const l = layerOf(n.kind);
    (byLayer.get(l) ?? byLayer.set(l, []).get(l)!).push(n);
  }
  const columns = [...byLayer.keys()].sort((a, b) => a - b).map((l) => byLayer.get(l)!.map((n) => n.id));

  const rowOf = new Map<NodeId, number>();
  const assignRows = (col: NodeId[]) => col.forEach((id, i) => rowOf.set(id, i));
  columns.forEach(assignRows);

  const order = (col: NodeId[], neighbours: Map<NodeId, NodeId[]>) => {
    const key = (id: NodeId): number | null => {
      const ns = (neighbours.get(id) ?? []).map((n) => rowOf.get(n)).filter((r): r is number => r !== undefined);
      return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
    };
    const keyed = col.map((id) => ({ id, k: key(id) }));
    keyed.sort((a, b) => {
      if (a.k === null && b.k === null) return a.id.localeCompare(b.id);
      if (a.k === null) return 1;
      if (b.k === null) return -1;
      return a.k - b.k || a.id.localeCompare(b.id);
    });
    const sorted = keyed.map((k) => k.id);
    assignRows(sorted);
    return sorted;
  };

  // Sweep left→right on predecessors, then right→left on successors.
  for (let i = 1; i < columns.length; i++) columns[i] = order(columns[i], preds);
  for (let i = columns.length - 2; i >= 0; i--) columns[i] = order(columns[i], succs);

  const positions = new Map<NodeId, Position>();
  columns.forEach((col, c) => {
    col.forEach((id, r) => positions.set(id, { x: c * (NODE_WIDTH + COLUMN_GAP), y: r * (NODE_HEIGHT + ROW_GAP) }));
  });
  return positions;
}
