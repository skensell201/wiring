import type { GraphEdge, GraphNode, Kind, NodeId } from "../../shared/ipc/types";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 64;
export const COLUMN_GAP = 96;
export const ROW_GAP = 24;

export interface Position { x: number; y: number }

export interface Layout {
  positions: Map<NodeId, Position>;
  /** Edge id → centres of the dummy slots the edge passes through, ordered from source to target.
   *  Only edges spanning more than one column have an entry. */
  waypoints: Map<string, Position[]>;
}

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

/** A slot in a column: a real node id, or a dummy that reserves a row for a passing edge. */
type SlotId = string;

/**
 * Deterministic Sugiyama-style layered layout: one column per (non-empty) layer, rows ordered by
 * the barycenter of already-placed neighbours, ties broken by id, orphans last.
 *
 * Edges spanning more than one column are split into a chain of dummy slots, one per intermediate
 * column. Dummies are ordered like nodes (so they sit between their chain neighbours) and occupy a
 * full row slot, so real nodes move aside and the edge passes through empty space instead of behind
 * a card. All long edges from one source into one target column share a single chain (a bundle);
 * they fan out to their individual targets only in the last segment.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[]): Layout {
  const ids = new Set(nodes.map((n) => n.id));

  // Group by layer, drop empty layers.
  const byLayer = new Map<number, GraphNode[]>();
  for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const l = layerOf(n.kind);
    (byLayer.get(l) ?? byLayer.set(l, []).get(l)!).push(n);
  }
  const columns: SlotId[][] = [...byLayer.keys()].sort((a, b) => a - b).map((l) => byLayer.get(l)!.map((n) => n.id));
  const columnOf = new Map<SlotId, number>();
  columns.forEach((col, c) => col.forEach((id) => columnOf.set(id, c)));

  // Chain neighbours: for a short edge just source→target; for a long edge the dummies in between.
  const preds = new Map<SlotId, SlotId[]>();
  const succs = new Map<SlotId, SlotId[]>();
  const link = (from: SlotId, to: SlotId) => {
    (preds.get(to) ?? preds.set(to, []).get(to)!).push(from);
    (succs.get(from) ?? succs.set(from, []).get(from)!).push(to);
  };
  const dummies = new Set<SlotId>();
  const chains = new Map<string, SlotId[]>(); // "source->col N" → dummy slot ids, source-to-target order
  const chainKeyOf = new Map<string, string>(); // edge id → chain key
  for (const e of [...edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    const sc = columnOf.get(e.source)!;
    const tc = columnOf.get(e.target)!;
    if (Math.abs(tc - sc) <= 1) {
      link(e.source, e.target);
      continue;
    }
    const key = `${e.source}->col${tc}`;
    chainKeyOf.set(e.id, key);
    let chain = chains.get(key);
    if (!chain) {
      chain = [];
      const step = tc > sc ? 1 : -1;
      let prev: SlotId = e.source;
      for (let c = sc + step; c !== tc; c += step) {
        const d = `#${key}@${c}`; // node ids are "Kind/ns/name", so "#..." never collides
        dummies.add(d);
        columns[c].push(d);
        columnOf.set(d, c);
        chain.push(d);
        link(prev, d);
        prev = d;
      }
      chains.set(key, chain);
    }
    // The bundle's last dummy fans out to every target, so its barycenter covers all of them.
    link(chain[chain.length - 1], e.target);
  }

  const rowOf = new Map<SlotId, number>();
  const assignRows = (col: SlotId[]) => col.forEach((id, i) => rowOf.set(id, i));
  columns.forEach(assignRows);

  // Ties: dummies before real nodes (a bundle hugs the top of the group it targets), then by id
  // (a dummy id embeds its source and target column).
  const compareIds = (a: SlotId, b: SlotId) => Number(dummies.has(b)) - Number(dummies.has(a)) || a.localeCompare(b);

  const order = (col: SlotId[], neighbours: Map<SlotId, SlotId[]>) => {
    const key = (id: SlotId): number | null => {
      const ns = (neighbours.get(id) ?? []).map((n) => rowOf.get(n)).filter((r): r is number => r !== undefined);
      return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
    };
    const keyed = col.map((id) => ({ id, k: key(id) }));
    keyed.sort((a, b) => {
      if (a.k === null && b.k === null) return compareIds(a.id, b.id);
      if (a.k === null) return 1;
      if (b.k === null) return -1;
      return a.k - b.k || compareIds(a.id, b.id);
    });
    const sorted = keyed.map((k) => k.id);
    assignRows(sorted);
    return sorted;
  };

  // Sweep left→right on predecessors, then right→left on successors.
  for (let i = 1; i < columns.length; i++) columns[i] = order(columns[i], preds);
  for (let i = columns.length - 2; i >= 0; i--) columns[i] = order(columns[i], succs);

  const slotAt = new Map<SlotId, Position>();
  columns.forEach((col, c) => {
    col.forEach((id, r) => slotAt.set(id, { x: c * (NODE_WIDTH + COLUMN_GAP), y: r * (NODE_HEIGHT + ROW_GAP) }));
  });

  const positions = new Map<NodeId, Position>();
  for (const id of ids) positions.set(id, slotAt.get(id)!);

  const centres = new Map<string, Position[]>();
  for (const [key, chain] of chains) {
    centres.set(key, chain.map((d) => {
      const p = slotAt.get(d)!;
      return { x: p.x + NODE_WIDTH / 2, y: p.y + NODE_HEIGHT / 2 };
    }));
  }
  const waypoints = new Map<string, Position[]>();
  for (const [edgeId, key] of chainKeyOf) waypoints.set(edgeId, centres.get(key)!);
  return { positions, waypoints };
}
