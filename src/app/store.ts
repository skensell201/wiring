import { create } from "zustand";
import { commands } from "../shared/ipc/commands";
import type {
  AppError, ConnectionState, ContextInfo, Graph, GraphDelta, GraphEdge, GraphNode, K8sEvent, Kind, NodeId, ObjectDetails,
} from "../shared/ipc/types";
import { toAppError } from "../shared/ipc/types";

export interface Toast { id: number; kind: AppError["kind"] | "info"; message: string }

export interface Details { nodeId: NodeId; data: ObjectDetails | null; events: K8sEvent[]; loading: boolean }

export interface Connection {
  state: ConnectionState;
  context: string | null;
  serverVersion: string | null;
  namespaces: string[];
  namespace: string | null;
  busy: boolean;
}

export interface GraphState {
  nodes: Map<NodeId, GraphNode>;
  edges: Map<string, GraphEdge>;
  /** false between select_namespace and the next graph_snapshot — deltas are ignored meanwhile. */
  graphReady: boolean;
  selectedId: NodeId | null;
  details: Details | null;
}

export interface AppState extends GraphState {
  contexts: ContextInfo[];
  connection: Connection;
  hoveredId: NodeId | null;
  expandedGroups: Set<NodeId>;
  hiddenKinds: Set<Kind>;
  deniedKinds: Set<Kind>;
  search: string;
  toasts: Toast[];
  pickerOpen: boolean;

  // graph events
  applySnapshot: (g: Graph) => void;
  applyDelta: (d: GraphDelta) => void;
  setObjectEvents: (nodeId: NodeId, events: K8sEvent[]) => void;
  setConnectionState: (s: ConnectionState) => void;
  // user actions
  loadContexts: () => Promise<void>;
  addKubeconfig: (path: string) => Promise<void>;
  connect: (context: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  selectNamespace: (namespace: string) => Promise<void>;
  select: (id: NodeId | null) => Promise<void>;
  setHovered: (id: NodeId | null) => void;
  toggleGroup: (id: NodeId) => Promise<void>;
  toggleKind: (kind: Kind) => void;
  setSearch: (q: string) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  setPickerOpen: (open: boolean) => void;
}

let toastSeq = 0;

export function initialState(): Omit<AppState, keyof Actions> {
  return {
    contexts: [],
    connection: { state: "disconnected", context: null, serverVersion: null, namespaces: [], namespace: null, busy: false },
    nodes: new Map(),
    edges: new Map(),
    graphReady: false,
    selectedId: null,
    details: null,
    hoveredId: null,
    expandedGroups: new Set(),
    hiddenKinds: new Set(),
    deniedKinds: new Set(),
    search: "",
    toasts: [],
    pickerOpen: false,
  };
}

type Actions = Pick<AppState,
  | "applySnapshot" | "applyDelta" | "setObjectEvents" | "setConnectionState" | "loadContexts" | "addKubeconfig" | "connect"
  | "disconnect" | "selectNamespace" | "select" | "setHovered" | "toggleGroup" | "toggleKind" | "setSearch" | "toast"
  | "dismissToast" | "setPickerOpen">;

// ---- pure reducers --------------------------------------------------------

export function applySnapshot<S extends GraphState>(s: S, g: Graph): S {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const edges = new Map(g.edges.map((e) => [e.id, e]));
  return keepSelection({ ...s, nodes, edges, graphReady: true });
}

export function applyDelta<S extends GraphState>(s: S, d: GraphDelta): S {
  if (!s.graphReady) return s;
  const nodes = new Map(s.nodes);
  const edges = new Map(s.edges);
  for (const id of d.removedNodes) nodes.delete(id);
  for (const n of d.addedNodes) nodes.set(n.id, n);
  for (const n of d.updatedNodes) nodes.set(n.id, n);
  for (const id of d.removedEdges) edges.delete(id);
  for (const e of d.addedEdges) edges.set(e.id, e);
  return keepSelection({ ...s, nodes, edges });
}

function keepSelection<S extends GraphState>(s: S): S {
  if (s.selectedId && !s.nodes.has(s.selectedId)) return { ...s, selectedId: null, details: null };
  return s;
}

// ---- store ----------------------------------------------------------------

export const useAppStore = create<AppState>()((set, get) => ({
  ...initialState(),

  applySnapshot: (g) => set((s) => applySnapshot(s, g)),
  applyDelta: (d) => set((s) => applyDelta(s, d)),
  setObjectEvents: (nodeId, events) =>
    set((s) => (s.details && s.details.nodeId === nodeId ? { details: { ...s.details, events } } : {})),
  setConnectionState: (state) => set((s) => ({ connection: { ...s.connection, state } })),

  loadContexts: async () => {
    try {
      set({ contexts: await commands.listContexts() });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  addKubeconfig: async (path) => {
    try {
      set({ contexts: await commands.addKubeconfig(path) });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  connect: async (context) => {
    set((s) => ({ connection: { ...s.connection, busy: true } }));
    try {
      const info = await commands.connect(context);
      set({
        ...initialState(),
        contexts: get().contexts,
        hiddenKinds: get().hiddenKinds,
        connection: { state: "connected", context: info.context, serverVersion: info.serverVersion, namespaces: info.namespaces, namespace: null, busy: false },
      });
      return true;
    } catch (e) {
      set((s) => ({ connection: { ...s.connection, busy: false } }));
      get().toast(toAppError(e));
      return false;
    }
  },

  disconnect: async () => {
    try {
      await commands.disconnect();
    } finally {
      set({ ...initialState(), contexts: get().contexts, hiddenKinds: get().hiddenKinds, pickerOpen: true });
    }
  },

  selectNamespace: async (namespace) => {
    const expanded = [...get().expandedGroups];
    set((s) => ({
      nodes: new Map(), edges: new Map(), graphReady: false, selectedId: null, details: null, hoveredId: null,
      deniedKinds: new Set(), connection: { ...s.connection, namespace },
    }));
    try {
      await commands.selectNamespace(namespace, expanded);
      set({ deniedKinds: new Set(await commands.deniedKinds()) });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  select: async (id) => {
    if (id === null) {
      set({ selectedId: null, details: null });
      await commands.watchEvents(null).catch(() => {});
      return;
    }
    set({ selectedId: id, details: { nodeId: id, data: null, events: [], loading: true } });
    try {
      const [data] = await Promise.all([commands.getObject(id), commands.watchEvents(id)]);
      set((s) => (s.selectedId === id ? { details: { nodeId: id, data, events: s.details?.events ?? [], loading: false } } : {}));
    } catch (e) {
      set((s) => (s.selectedId === id ? { details: { nodeId: id, data: null, events: [], loading: false } } : {}));
      get().toast(toAppError(e));
    }
  },

  setHovered: (id) => set({ hoveredId: id }),

  toggleGroup: async (id) => {
    const next = new Set(get().expandedGroups);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ expandedGroups: next });
    try {
      await commands.setExpandedGroups([...next]);
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  toggleKind: (kind) =>
    set((s) => {
      const next = new Set(s.hiddenKinds);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return { hiddenKinds: next };
    }),

  setSearch: (search) => set({ search }),

  toast: (t) => set((s) => ({ toasts: [...s.toasts, { id: ++toastSeq, ...t }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setPickerOpen: (pickerOpen) => set({ pickerOpen }),
}));
