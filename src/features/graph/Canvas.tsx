import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { Kind } from "../../shared/ipc/types";
import { KindChips } from "./KindChips";
import { RelationEdge } from "./RelationEdge";
import { ResourceNode } from "./ResourceNode";
import { toFlow, type ResourceFlowNode } from "./toFlow";

const nodeTypes = { resource: ResourceNode };
const edgeTypes = { relation: RelationEdge };

function CanvasInner() {
  const s = useAppStore(
    useShallow((s) => ({
      nodes: s.nodes, edges: s.edges, graphReady: s.graphReady, hiddenKinds: s.hiddenKinds, deniedKinds: s.deniedKinds,
      search: s.search, hoveredId: s.hoveredId, selectedId: s.selectedId, expandedGroups: s.expandedGroups,
      namespace: s.connection.namespace, context: s.connection.context, focusRequest: s.focusRequest,
      select: s.select, setHovered: s.setHovered, toggleGroup: s.toggleGroup, toggleKind: s.toggleKind,
    })),
  );

  const flow = useMemo(() => toFlow(s), [s.nodes, s.edges, s.hiddenKinds, s.search, s.hoveredId, s.selectedId, s.expandedGroups]);
  const present = useMemo(() => new Set<Kind>([...s.nodes.values()].map((n) => n.kind)), [s.nodes]);

  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!s.graphReady) return;
    // A single pass can fire before React Flow has measured the freshly laid-out nodes (e.g. the
    // first snapshot of a namespace), leaving the viewport off. Fit once now and once more shortly
    // after so a late measurement still gets picked up.
    fitView({ padding: 0.2, maxZoom: 1 });
    const timeout = setTimeout(() => fitView({ padding: 0.2, maxZoom: 1 }), 50);
    return () => clearTimeout(timeout);
  }, [s.graphReady, s.namespace, fitView]);

  // "Show in graph": centre on the requested node every time the request is bumped. Coming from a
  // table the canvas has just mounted, so the node may be unmeasured and the whole-graph fit above
  // is still pending — repeat the focus once that has settled.
  const focusSeq = s.focusRequest?.seq;
  const focusNodeId = s.focusRequest?.nodeId;
  useEffect(() => {
    if (focusSeq === undefined || !focusNodeId) return;
    const focus = () => void fitView({ nodes: [{ id: focusNodeId }], duration: 300, maxZoom: 1.2, padding: 0.5 });
    focus();
    const timeout = setTimeout(focus, 80);
    return () => clearTimeout(timeout);
  }, [focusSeq, focusNodeId, fitView]);

  const onNodeClick = useCallback<NodeMouseHandler<ResourceFlowNode>>((_, node) => void s.select(node.id), [s.select]);
  const onNodeDoubleClick = useCallback<NodeMouseHandler<ResourceFlowNode>>((_, node) => {
    if (node.data.node.kind === "PodGroup") void s.toggleGroup(node.id);
  }, [s.toggleGroup]);
  const onNodeMouseEnter = useCallback<NodeMouseHandler<ResourceFlowNode>>((_, node) => s.setHovered(node.id), [s.setHovered]);
  const onNodeMouseLeave = useCallback(() => s.setHovered(null), [s.setHovered]);
  const onPaneClick = useCallback(() => { if (s.selectedId !== null) void s.select(null); }, [s.selectedId, s.select]);

  let overlay: string | null = null;
  if (!s.context) overlay = "Connect to a cluster to see its graph.";
  else if (!s.namespace) overlay = "Select a namespace to see its graph.";
  else if (!s.graphReady) overlay = `Loading ${s.namespace}…`;
  else if (s.nodes.size === 0) overlay = "Namespace is empty.";

  return (
    <div className="relative h-full w-full bg-void">
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        zoomOnDoubleClick={false}
        elementsSelectable
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.1}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={onPaneClick}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#2c2834" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor="#3e3a46"
          nodeStrokeColor="#6b21ef"
          nodeStrokeWidth={2}
          maskColor="rgba(14,9,24,0.6)"
          style={{ background: "#1b1728", border: "1px solid #3e3a46", borderRadius: 12 }}
        />
      </ReactFlow>
      <div className="pointer-events-none absolute inset-x-3 top-3 flex">
        <div className="pointer-events-auto">
          <KindChips hidden={s.hiddenKinds} denied={s.deniedKinds} present={present} onToggle={s.toggleKind} />
        </div>
      </div>
      {overlay && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-text-muted">{overlay}</div>
      )}
    </div>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
