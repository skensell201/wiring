import type { Edge, Node } from "@xyflow/react";
import type { GraphEdge, GraphNode, Kind, NodeId } from "../../shared/ipc/types";
import { problemPath } from "./problemPath";
import { layout, NODE_HEIGHT, NODE_WIDTH, type Position } from "./layout";

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

export interface ToFlowInput {
  nodes: Map<NodeId, GraphNode>;
  edges: Map<string, GraphEdge>;
  hiddenKinds: Set<Kind>;
  search: string;
  hoveredId: NodeId | null;
  selectedId: NodeId | null;
  expandedGroups: Set<NodeId>;
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

export function toFlow(input: ToFlowInput): { nodes: ResourceFlowNode[]; edges: RelationFlowEdge[] } {
  const visible = [...input.nodes.values()].filter((n) => !input.hiddenKinds.has(n.kind));
  const visibleIds = new Set(visible.map((n) => n.id));
  const visibleEdges = [...input.edges.values()].filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
  const { positions, waypoints } = layout(visible, visibleEdges);

  const q = input.search.trim().toLowerCase();
  const matches = (n: GraphNode) => q === "" || n.name.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q);

  // The selected node's problem chain (only when it leads somewhere): its nodes and the edges
  // between consecutive steps (either direction) are tinted in the root cause's status colour,
  // the same colour the details' problem block uses.
  const selected = input.selectedId !== null ? input.nodes.get(input.selectedId) : undefined;
  const path = selected?.status === "err" || selected?.status === "warn" ? problemPath(selected.id, input.nodes) : [];
  const rootStatus = path.length > 0 ? input.nodes.get(path[path.length - 1])?.status : undefined;
  const tone: PathTone | undefined = rootStatus === "err" || rootStatus === "warn" ? rootStatus : undefined;
  const onPath = new Set(path.length > 1 ? path : []);
  const pathLinks = new Set(onPath.size > 0 ? path.slice(1).flatMap((to, i) => [`${path[i]}\n${to}`, `${to}\n${path[i]}`]) : []);

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
    data: nodeData(node, !matches(node), input.expandedGroups.has(node.id), onPath.has(node.id) ? tone : undefined),
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

  return { nodes, edges };
}
