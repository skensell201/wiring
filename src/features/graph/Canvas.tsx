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
import { GraphEmpty } from "./GraphEmpty";
import { graphEmptyState } from "./graphEmptyState";
import { RelationEdge } from "./RelationEdge";
import { LaneNode } from "./LaneNode";
import { ResourceNode } from "./ResourceNode";
import { toFlow, type FlowNode } from "./toFlow";

const nodeTypes = { resource: ResourceNode, lane: LaneNode };
const edgeTypes = { relation: RelationEdge };

/** Lanes would paint solid blocks over the minimap's nodes; draw only resources there. */
const miniMapColor = (n: FlowNode) => (n.type === "lane" ? "transparent" : "#3a3340");
const miniMapStroke = (n: FlowNode) => (n.type === "lane" ? "transparent" : "#b997ff");

/** If React Flow never reports the nodes measured (it can when nothing changed), settle anyway. */
const FOCUS_SETTLE_FALLBACK_MS = 150;

function CanvasInner() {
  const s = useAppStore(
    useShallow((s) => ({
      nodes: s.nodes, edges: s.edges, tooLarge: s.tooLarge, graphReady: s.graphReady, hiddenKinds: s.hiddenKinds,
      deniedKinds: s.deniedKinds, partialKinds: s.partialKinds, deniedLoaded: s.deniedLoaded, canListNamespaces: s.connection.canListNamespaces,
      search: s.search, hoveredId: s.hoveredId, selectedId: s.selectedId, expandedGroups: s.expandedGroups, highlightIds: s.highlightIds,
      scope: s.connection.scope, namespaces: s.connection.namespaces, context: s.connection.context, focusRequest: s.focusRequest,
      select: s.select, openActionsMenu: s.openActionsMenu, setHovered: s.setHovered, toggleGroup: s.toggleGroup,
      clearFocusRequest: s.clearFocusRequest,
    })),
  );

  const flow = useMemo(() => {
    const { lanes, nodes, edges } = toFlow(s);
    // Lanes first, so their frames sit behind the nodes in DOM order too (they also carry zIndex -1).
    return { nodes: lanes.length > 0 ? [...lanes, ...nodes] : (nodes as FlowNode[]), edges };
  }, [s.nodes, s.edges, s.hiddenKinds, s.search, s.hoveredId, s.selectedId, s.expandedGroups, s.highlightIds]);

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
  }, [s.graphReady, s.scope, fitView]);

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

  // Lane frames take no pointer events, so these only ever see resources; the guards keep it so.
  const onNodeClick = useCallback<NodeMouseHandler<FlowNode>>((_, node) => {
    if (node.type === "resource") void s.select(node.id);
  }, [s.select]);
  const onNodeDoubleClick = useCallback<NodeMouseHandler<FlowNode>>((_, node) => {
    if (node.type === "resource" && node.data.node.kind === "PodGroup") void s.toggleGroup(node.id);
  }, [s.toggleGroup]);
  const onNodeContextMenu = useCallback<NodeMouseHandler<FlowNode>>((e, node) => {
    if (node.type !== "resource") return;
    e.preventDefault();
    s.openActionsMenu(node.id, e.clientX, e.clientY);
  }, [s.openActionsMenu]);
  const onNodeMouseEnter = useCallback<NodeMouseHandler<FlowNode>>((_, node) => {
    if (node.type === "resource") s.setHovered(node.id);
  }, [s.setHovered]);
  const onNodeMouseLeave = useCallback(() => s.setHovered(null), [s.setHovered]);
  const onPaneClick = useCallback(() => { if (s.selectedId !== null) void s.select(null); }, [s.selectedId, s.select]);

  // Memoized on its inputs: the canvas re-renders on every hover.
  const empty = useMemo(() => graphEmptyState(s), [
    s.context, s.scope, s.namespaces, s.canListNamespaces, s.graphReady, s.tooLarge,
    s.deniedKinds, s.partialKinds, s.deniedLoaded, s.nodes, s.hiddenKinds, s.search,
  ]);

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
        onNodeContextMenu={onNodeContextMenu}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={onPaneClick}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#3a3340" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeColor={miniMapColor}
          nodeStrokeColor={miniMapStroke}
          nodeStrokeWidth={2}
          maskColor="rgba(28,22,36,0.6)"
          style={{ background: "#2d2734", border: "1px solid rgb(229 231 235 / 0.12)", borderRadius: 20 }}
        />
      </ReactFlow>
      {empty && <GraphEmpty state={empty} />}
      {/* Until the connection pane replaces the views while disconnected. */}
      {!s.context && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-text-muted">Connect to a cluster to see its graph.</div>
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
