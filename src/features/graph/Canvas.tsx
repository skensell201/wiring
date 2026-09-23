import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { Kind } from "../../shared/ipc/types";
import { KindChips } from "./KindChips";
import { RelationEdge } from "./RelationEdge";
import { ResourceNode } from "./ResourceNode";
import { toFlow, type ResourceFlowNode } from "./toFlow";

const nodeTypes = { resource: ResourceNode };
const edgeTypes = { relation: RelationEdge };

/** If React Flow never reports the nodes measured (it can when nothing changed), settle anyway. */
const FOCUS_SETTLE_FALLBACK_MS = 150;

function CanvasInner() {
  const s = useAppStore(
    useShallow((s) => ({
      nodes: s.nodes, edges: s.edges, graphReady: s.graphReady, hiddenKinds: s.hiddenKinds, deniedKinds: s.deniedKinds,
      search: s.search, hoveredId: s.hoveredId, selectedId: s.selectedId, expandedGroups: s.expandedGroups,
      namespace: s.connection.namespace, context: s.connection.context, focusRequest: s.focusRequest,
      select: s.select, setHovered: s.setHovered, toggleGroup: s.toggleGroup, toggleKind: s.toggleKind,
      clearFocusRequest: s.clearFocusRequest,
    })),
  );

  const flow = useMemo(() => toFlow(s), [s.nodes, s.edges, s.hiddenKinds, s.search, s.hoveredId, s.selectedId, s.expandedGroups]);
  const present = useMemo(() => new Set<Kind>([...s.nodes.values()].map((n) => n.kind)), [s.nodes]);

  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  // Whether a "Show in graph" request is pending, readable from the overview fit's timer without
  // making that effect re-run (and re-fit) when the request is consumed.
  const focusPending = useRef(s.focusRequest !== null);
  focusPending.current = s.focusRequest !== null;

  useEffect(() => {
    if (!s.graphReady || focusPending.current) return; // a focus request owns the viewport
    // A single pass can fire before React Flow has measured the freshly laid-out nodes (e.g. the
    // first snapshot of a namespace), leaving the viewport off. Fit once now and once more shortly
    // after so a late measurement still gets picked up.
    fitView({ padding: 0.2, maxZoom: 1 });
    const timeout = setTimeout(() => { if (!focusPending.current) void fitView({ padding: 0.2, maxZoom: 1 }); }, 50);
    return () => clearTimeout(timeout);
  }, [s.graphReady, s.namespace, fitView]);

  // "Show in graph": centre on the requested node every time the request is bumped. Coming from a
  // table the canvas has just mounted, so the node is unmeasured: focus once now, and once more
  // when React Flow has measured the nodes (or after a fallback delay), then consume the request
  // so it does not replay on a later mount.
  const focusSeq = s.focusRequest?.seq;
  const focusNodeId = s.focusRequest?.nodeId;
  const firstPassSeq = useRef<number | null>(null);
  useEffect(() => {
    if (focusSeq === undefined || !focusNodeId) return;
    const focus = () => void fitView({ nodes: [{ id: focusNodeId }], duration: 300, maxZoom: 1.2, padding: 0.5 });
    if (firstPassSeq.current !== focusSeq) {
      firstPassSeq.current = focusSeq;
      focus();
    }
    const settle = () => { focus(); s.clearFocusRequest(); };
    if (nodesInitialized) { settle(); return; }
    const timeout = setTimeout(settle, FOCUS_SETTLE_FALLBACK_MS);
    return () => clearTimeout(timeout);
  }, [focusSeq, focusNodeId, nodesInitialized, fitView, s.clearFocusRequest]);

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
    <div className="relative h-full w-full bg-space">
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
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#33323e" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor="#33323e"
          nodeStrokeColor="#a05fcf"
          nodeStrokeWidth={2}
          maskColor="rgba(13,12,20,0.6)"
          style={{ background: "#1a191f", border: "1px solid #33323e", borderRadius: 12 }}
        />
      </ReactFlow>
      <div className="pointer-events-none absolute inset-x-8 top-4 flex">
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
