import { create } from "zustand";
import { commands } from "../shared/ipc/commands";
import type {
  AppError, ConnectionState, ContextInfo, Graph, GraphDelta, GraphEdge, GraphNode, K8sEvent, Kind, NodeId, ObjectDetails, Status,
  Table,
} from "../shared/ipc/types";
import { toAppError } from "../shared/ipc/types";
import { settings } from "../shared/settings";
import { cancelTableRefresh } from "./tableRefresh";

export interface Toast { id: number; kind: AppError["kind"] | "info"; message: string }

export interface Details { nodeId: NodeId; data: ObjectDetails | null; events: K8sEvent[]; loading: boolean }

/** The centre pane: the graph, or a per-kind table. */
export type View = { name: "graph" } | { name: "table"; kind: Kind };

/** Bumped every time the graph should centre on `nodeId` (even re-focusing the same node). */
export interface FocusRequest { nodeId: NodeId; seq: number }

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
  view: View;
  sidebarCollapsed: boolean;
  tables: Map<Kind, Table>;
  focusRequest: FocusRequest | null;

  // graph events
  applySnapshot: (g: Graph) => void;
  applyDelta: (d: GraphDelta) => void;
  setObjectEvents: (nodeId: NodeId, events: K8sEvent[]) => void;
  setConnectionState: (s: ConnectionState) => void;
  // user actions
  loadContexts: () => Promise<void>;
  addKubeconfig: (path: string) => Promise<void>;
  connect: (context: string) => Promise<boolean>;
  reconnect: () => Promise<void>;
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
  // views and tables
  showGraph: () => void;
  showTable: (kind: Kind) => Promise<void>;
  refreshTable: (kind: Kind) => Promise<void>;
  focusInGraph: (id: NodeId) => Promise<void>;
  toggleSidebar: () => Promise<void>;
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
    view: { name: "graph" },
    sidebarCollapsed: false,
    tables: new Map(),
    focusRequest: null,
  };
}

/** The state after the session is gone: graph, selection and connection reset, the context list,
 *  kind filters, toasts and the sidebar collapse preference kept, and the picker opened so the
 *  user can choose where to go next. */
export function disconnectedState(s: AppState): Omit<AppState, keyof Actions> {
  return {
    ...initialState(), contexts: s.contexts, hiddenKinds: s.hiddenKinds, toasts: s.toasts, pickerOpen: true,
    sidebarCollapsed: s.sidebarCollapsed,
  };
}

type Actions = Pick<AppState,
  | "applySnapshot" | "applyDelta" | "setObjectEvents" | "setConnectionState" | "loadContexts" | "addKubeconfig" | "connect"
  | "reconnect" | "disconnect" | "selectNamespace" | "select" | "setHovered" | "toggleGroup" | "toggleKind" | "setSearch" | "toast"
  | "dismissToast" | "setPickerOpen" | "showGraph" | "showTable" | "refreshTable" | "focusInGraph" | "toggleSidebar">;

// ---- selectors --------------------------------------------------------------

const STATUS_RANK: Record<Status, number> = { unknown: 0, ok: 1, warn: 2, err: 3 };

/** Per-kind node counts and worst status, for the Navigator tree. Collapsed `PodGroup` nodes
 *  count towards `Pod` (using the group's own aggregate count and status); `PodGroup` itself
 *  never appears as a key. */
export function kindStats(nodes: Map<NodeId, GraphNode>): Map<Kind, { count: number; worst: Status }> {
  const stats = new Map<Kind, { count: number; worst: Status }>();
  const add = (kind: Kind, count: number, status: Status) => {
    const cur = stats.get(kind);
    if (!cur) {
      stats.set(kind, { count, worst: status });
    } else {
      cur.count += count;
      if (STATUS_RANK[status] > STATUS_RANK[cur.worst]) cur.worst = status;
    }
  };
  for (const n of nodes.values()) {
    if (n.kind === "PodGroup") add("Pod", n.group?.count ?? 0, n.status);
    else add(n.kind, 1, n.status);
  }
  return stats;
}

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

  applySnapshot: (g) =>
    set((s) => {
      // Belt and braces: a snapshot of the previous namespace can still be queued behind
      // select_namespace; the namespaced nodes tell which namespace it belongs to.
      const namespaced = g.nodes.find((n) => n.namespace !== null);
      if (namespaced && namespaced.namespace !== s.connection.namespace) return s;
      return applySnapshot(s, g);
    }),
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
        sidebarCollapsed: get().sidebarCollapsed,
        connection: { state: "connected", context: info.context, serverVersion: info.serverVersion, namespaces: info.namespaces, namespace: null, busy: false },
      });
      return true;
    } catch (e) {
      // The backend tears the previous session down before dialling, so a failed connect leaves
      // the app disconnected whatever it was before.
      set(disconnectedState(get()));
      get().toast(toAppError(e));
      return false;
    }
  },

  reconnect: async () => {
    const { context, namespace } = get().connection;
    if (!context) return;
    const ok = await get().connect(context);
    if (ok && namespace) await get().selectNamespace(namespace);
  },

  disconnect: async () => {
    try {
      await commands.disconnect();
    } catch (e) {
      get().toast(toAppError(e));
    } finally {
      set(disconnectedState(get()));
    }
  },

  selectNamespace: async (namespace) => {
    cancelTableRefresh();
    const expanded = [...get().expandedGroups];
    set((s) => ({
      nodes: new Map(), edges: new Map(), graphReady: false, selectedId: null, details: null, hoveredId: null,
      deniedKinds: new Set(), tables: new Map(), connection: { ...s.connection, namespace },
    }));
    try {
      await commands.selectNamespace(namespace, expanded);
      const denied = await commands.deniedKinds();
      // Only if this is still the current selection — a newer one owns deniedKinds now.
      if (get().connection.namespace === namespace) set({ deniedKinds: new Set(denied) });
      const view = get().view;
      // Fire-and-forget: the namespace switch itself must not wait on the table refetch.
      if (view.name === "table") void get().refreshTable(view.kind);
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  select: async (id) => {
    if (id === get().selectedId) return;
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

  showGraph: () => set({ view: { name: "graph" } }),

  showTable: async (kind) => {
    set({ view: { name: "table", kind } });
    await get().refreshTable(kind);
  },

  refreshTable: async (kind) => {
    const ns = get().connection.namespace;
    try {
      const table = await commands.listRows(kind);
      // The namespace moved on while this fetch was in flight — its rows are stale.
      if (ns === null || get().connection.namespace !== ns) return;
      set((s) => {
        const tables = new Map(s.tables);
        tables.set(kind, table);
        return { tables };
      });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  focusInGraph: async (id) => {
    if (!get().nodes.has(id)) {
      const name = id.split("/").pop() ?? id;
      get().toast({ kind: "info", message: `${name} is not shown in the graph (filtered or collapsed)` });
      return;
    }
    get().showGraph();
    await get().select(id);
    set((s) => ({ focusRequest: { nodeId: id, seq: (s.focusRequest?.seq ?? 0) + 1 } }));
  },

  toggleSidebar: async () => {
    const next = !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    await settings.setSidebarCollapsed(next);
  },
}));
