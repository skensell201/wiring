import type { Edge, Node } from "@xyflow/react";
import type { GraphEdge, GraphNode, Kind, NodeId } from "../../shared/ipc/types";
import { layout } from "./layout";

export interface ResourceNodeData extends Record<string, unknown> {
  node: GraphNode;
  dimmed: boolean;
  expanded: boolean;
}
export interface RelationEdgeData extends Record<string, unknown> {
  edge: GraphEdge;
  highlighted: boolean;
  dimmed: boolean;
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
function nodeData(node: GraphNode, dimmed: boolean, expanded: boolean): ResourceNodeData {
  const cached = nodeDataCache.get(node);
  if (cached && cached.dimmed === dimmed && cached.expanded === expanded) return cached;
  const data: ResourceNodeData = { node, dimmed, expanded };
  nodeDataCache.set(node, data);
  return data;
}

const edgeDataCache = new WeakMap<GraphEdge, RelationEdgeData>();
function edgeData(edge: GraphEdge, highlighted: boolean, dimmed: boolean): RelationEdgeData {
  const cached = edgeDataCache.get(edge);
  if (cached && cached.highlighted === highlighted && cached.dimmed === dimmed) return cached;
  const data: RelationEdgeData = { edge, highlighted, dimmed };
  edgeDataCache.set(edge, data);
  return data;
}

export function toFlow(input: ToFlowInput): { nodes: ResourceFlowNode[]; edges: RelationFlowEdge[] } {
  const visible = [...input.nodes.values()].filter((n) => !input.hiddenKinds.has(n.kind));
  const visibleIds = new Set(visible.map((n) => n.id));
  const visibleEdges = [...input.edges.values()].filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
  const positions = layout(visible, visibleEdges);

  const q = input.search.trim().toLowerCase();
  const matches = (n: GraphNode) => q === "" || n.name.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q);

  const nodes: ResourceFlowNode[] = visible.map((node) => ({
    id: node.id,
    type: "resource",
    position: positions.get(node.id)!,
    selected: node.id === input.selectedId,
    data: nodeData(node, !matches(node), input.expandedGroups.has(node.id)),
  }));

  const hover = input.hoveredId;
  const edges: RelationFlowEdge[] = visibleEdges.map((edge) => {
    const touches = hover !== null && (edge.source === hover || edge.target === hover);
    return {
      id: edge.id,
      type: "relation",
      source: edge.source,
      target: edge.target,
      data: edgeData(edge, touches, hover !== null && !touches),
    };
  });

  return { nodes, edges };
}
