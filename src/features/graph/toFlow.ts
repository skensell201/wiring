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
    data: { node, dimmed: !matches(node), expanded: input.expandedGroups.has(node.id) },
  }));

  const hover = input.hoveredId;
  const edges: RelationFlowEdge[] = visibleEdges.map((edge) => {
    const touches = hover !== null && (edge.source === hover || edge.target === hover);
    return {
      id: edge.id,
      type: "relation",
      source: edge.source,
      target: edge.target,
      data: { edge, highlighted: touches, dimmed: hover !== null && !touches },
    };
  });

  return { nodes, edges };
}
