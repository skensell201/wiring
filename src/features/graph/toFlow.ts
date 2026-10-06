import type { Edge, Node } from "@xyflow/react";
import type { GraphEdge, GraphNode, Kind, NodeId } from "../../shared/ipc/types";
import { problemPath } from "./problemPath";
import { layout, NODE_HEIGHT, NODE_WIDTH, type Layout, type Position } from "./layout";

/** Status colour of the root cause of the selected node's problem path. */
export type PathTone = "err" | "warn";

export interface ResourceNodeData extends Record<string, unknown> {
  node: GraphNode;
  dimmed: boolean;
  expanded: boolean;
  pathTone?: PathTone;
}
export interface RelationEdgeData extends Record<string, unknown> {
  edge: GraphEdge;
  highlighted: boolean;
  dimmed: boolean;
  /** Dummy-slot centres the edge is routed through (only for edges spanning several columns). */
  waypoints?: Position[];
  pathTone?: PathTone;
}
export type ResourceFlowNode = Node<ResourceNodeData, "resource">;
// @xyflow/react's `Edge` has an optional `data` field; toFlow always sets it, so this
// narrows it to required (a subtype, still assignable wherever `Edge<...>` is expected).
export type RelationFlowEdge = Omit<Edge<RelationEdgeData, "relation">, "data"> & { data: RelationEdgeData };

/** Space for a lane's title above its first row, the padding around its nodes, and the gap between lanes. */
export const LANE_HEADER = 40;
export const LANE_PAD = 24;
export const LANE_GAP = 48;
export const CLUSTER_LANE_LABEL = "Cluster-scoped";

export interface LaneNodeData extends Record<string, unknown> {
  label: string;
  count: number;
}
/** A namespace's frame behind its nodes in a multi-namespace graph. */
export type LaneFlowNode = Node<LaneNodeData, "lane">;
export type FlowNode = ResourceFlowNode | LaneFlowNode;

export interface ToFlowInput {
  nodes: Map<NodeId, GraphNode>;
  edges: Map<string, GraphEdge>;
  hiddenKinds: Set<Kind>;
  search: string;
  hoveredId: NodeId | null;
  selectedId: NodeId | null;
  expandedGroups: Set<NodeId>;
  /** The selected Helm release's objects: everything else is dimmed while it is non-empty. */
  highlightIds?: Set<NodeId>;
}

// The store replaces a GraphNode/GraphEdge object whenever its content changes, so object
// identity is content identity. Caching each node/edge's flow `data` object by that identity —
// and only replacing it when the derived fields actually change — lets `memo(ResourceNode)` /
// `memo(RelationEdge)` skip re-rendering nodes/edges the current toFlow() call didn't affect.
const nodeDataCache = new WeakMap<GraphNode, ResourceNodeData>();
function nodeData(node: GraphNode, dimmed: boolean, expanded: boolean, pathTone: PathTone | undefined): ResourceNodeData {
  const cached = nodeDataCache.get(node);
  if (cached && cached.dimmed === dimmed && cached.expanded === expanded && cached.pathTone === pathTone) return cached;
  const data: ResourceNodeData = pathTone ? { node, dimmed, expanded, pathTone } : { node, dimmed, expanded };
  nodeDataCache.set(node, data);
  return data;
}

const sameWaypoints = (a: Position[] | undefined, b: Position[] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y));

const edgeDataCache = new WeakMap<GraphEdge, RelationEdgeData>();
function edgeData(edge: GraphEdge, highlighted: boolean, dimmed: boolean, waypoints: Position[] | undefined, pathTone: PathTone | undefined): RelationEdgeData {
  const cached = edgeDataCache.get(edge);
  if (cached && cached.highlighted === highlighted && cached.dimmed === dimmed && cached.pathTone === pathTone && sameWaypoints(cached.waypoints, waypoints)) return cached;
  const data: RelationEdgeData = { edge, highlighted, dimmed, ...(waypoints ? { waypoints } : {}), ...(pathTone ? { pathTone } : {}) };
  edgeDataCache.set(edge, data);
  return data;
}

type LanedLayout = Layout & { lanes: LaneFlowNode[] };

/**
 * Nodes spanning several namespaces: each namespace laid out on its own with `layout()`, the
 * results stacked vertically in name order (cluster-scoped objects in a last lane), each framed by
 * a lane. Edges between lanes get no waypoints. One namespace (plus any cluster-scoped objects) or
 * none: the plain layout, no lanes, exactly as before.
 */
function laneLayout(nodes: GraphNode[], edges: GraphEdge[]): LanedLayout {
  const keys = new Set(nodes.map((n) => n.namespace ?? ""));
  const named = [...keys].filter((k) => k !== "").sort((a, b) => a.localeCompare(b));
  if (named.length <= 1) return { ...layout(nodes, edges), lanes: [] };
  const order = keys.has("") ? [...named, ""] : named;
  const positions = new Map<NodeId, Position>();
  const waypoints = new Map<string, Position[]>();
  const lanes: LaneFlowNode[] = [];
  let top = 0;
  for (const key of order) {
    const members = nodes.filter((n) => (n.namespace ?? "") === key);
    const ids = new Set(members.map((n) => n.id));
    const inner = layout(members, edges.filter((e) => ids.has(e.source) && ids.has(e.target)));
    const shift = (p: Position): Position => ({ x: p.x + LANE_PAD, y: p.y + top + LANE_HEADER });
    let right = 0;
    let bottom = 0;
    for (const [id, p] of inner.positions) {
      positions.set(id, shift(p));
      right = Math.max(right, p.x + NODE_WIDTH);
      bottom = Math.max(bottom, p.y + NODE_HEIGHT);
    }
    for (const [edgeId, points] of inner.waypoints) waypoints.set(edgeId, points.map(shift));
    const width = right + 2 * LANE_PAD;
    const height = LANE_HEADER + bottom + LANE_PAD;
    lanes.push({
      id: `lane:${key}`, // node ids are "Kind/ns/name", so "lane:..." never collides
      type: "lane",
      position: { x: 0, y: top },
      width,
      height,
      // Inert: React Flow's node wrapper takes pointer events whenever node handlers are set, so
      // the inline style is what lets clicks, right-clicks and hovers through to edges and pane.
      // zIndex -1 paints the frame under the edge layer (it is transparent either way).
      style: { pointerEvents: "none" },
      zIndex: -1,
      draggable: false,
      selectable: false,
      focusable: false,
      connectable: false,
      deletable: false,
      data: { label: key === "" ? CLUSTER_LANE_LABEL : key, count: members.length },
    });
    top += height + LANE_GAP;
  }
  return { positions, waypoints, lanes };
}

// Layout depends only on which nodes (id, kind, namespace) and edges (id, endpoints) are visible,
// not on status or badges, so a status update reuses the last layout — and with it the position,
// waypoint and lane objects, which keeps the edge-data cache hitting.
let lastLayout: { key: string; result: LanedLayout } | null = null;
function cachedLayout(nodes: GraphNode[], edges: GraphEdge[]): LanedLayout {
  const key = `${nodes.map((n) => `${n.id}\t${n.kind}\t${n.namespace ?? ""}`).join("\n")}\n\n${edges.map((e) => `${e.id}\t${e.source}\t${e.target}`).join("\n")}`;
  if (lastLayout?.key === key) return lastLayout.result;
  const result = laneLayout(nodes, edges);
  lastLayout = { key, result };
  return result;
}

/** React Flow input: `lanes` are frames to render behind `nodes` (empty for a single namespace). */
export function toFlow(input: ToFlowInput): { lanes: LaneFlowNode[]; nodes: ResourceFlowNode[]; edges: RelationFlowEdge[] } {
  const visible = [...input.nodes.values()].filter((n) => !input.hiddenKinds.has(n.kind));
  const visibleIds = new Set(visible.map((n) => n.id));
  const visibleEdges = [...input.edges.values()].filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
  const { positions, waypoints, lanes } = cachedLayout(visible, visibleEdges);

  const q = input.search.trim().toLowerCase();
  // The namespace counts too, alone (`blog`) or as `blog/web`.
  const matches = (n: GraphNode) => q === "" || n.kind.toLowerCase().includes(q)
    || (n.namespace === null ? n.name : `${n.namespace}/${n.name}`).toLowerCase().includes(q);

  // The selected node's problem chain (only when it leads somewhere): its nodes and the edges
  // between consecutive steps (either direction) are tinted in the root cause's status colour,
  // the same colour the details' problem block uses.
  const selected = input.selectedId !== null ? input.nodes.get(input.selectedId) : undefined;
  const path = selected?.status === "err" || selected?.status === "warn" ? problemPath(selected.id, input.nodes) : [];
  const rootStatus = path.length > 0 ? input.nodes.get(path[path.length - 1])?.status : undefined;
  const tone: PathTone | undefined = rootStatus === "err" || rootStatus === "warn" ? rootStatus : undefined;
  const onPath = new Set(path.length > 1 ? path : []);
  const pathLinks = new Set(onPath.size > 0 ? path.slice(1).flatMap((to, i) => [`${path[i]}\n${to}`, `${to}\n${path[i]}`]) : []);

  const highlight = input.highlightIds ?? new Set<NodeId>();
  // A release's pods are usually collapsed into their owner's PodGroup (`PodGroup/<ns>/<Kind>/<name>`).
  const inRelease = (id: NodeId): boolean => {
    if (highlight.has(id)) return true;
    if (!id.startsWith("PodGroup/")) return false;
    const [, ns, ownerKind, ...name] = id.split("/");
    return highlight.has(`${ownerKind}/${ns}/${name.join("/")}`);
  };

  const nodes: ResourceFlowNode[] = visible.map((node) => ({
    id: node.id,
    type: "resource",
    position: positions.get(node.id)!,
    // React Flow 12's MiniMap only draws a node once it has dimensions (measured, or these
    // explicit ones); without them it renders nothing until the ResizeObserver catches up, and
    // fitView's first pass is likewise more stable when dimensions are known up front.
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    selected: node.id === input.selectedId,
    data: nodeData(node, !matches(node) || (highlight.size > 0 && !inRelease(node.id)), input.expandedGroups.has(node.id), onPath.has(node.id) ? tone : undefined),
  }));

  // hoveredId can outlive its node (a delta removed it before the mouse moved), and a hover that
  // touches nothing would otherwise dim every edge.
  const hover = input.hoveredId !== null && visibleIds.has(input.hoveredId) ? input.hoveredId : null;
  const edges: RelationFlowEdge[] = visibleEdges.map((edge) => {
    const touches = hover !== null && (edge.source === hover || edge.target === hover);
    const pathTone = pathLinks.has(`${edge.source}\n${edge.target}`) ? tone : undefined;
    return {
      id: edge.id,
      type: "relation",
      source: edge.source,
      target: edge.target,
      data: edgeData(edge, touches, hover !== null && !touches, waypoints.get(edge.id), pathTone),
    };
  });

  return { lanes, nodes, edges };
}
