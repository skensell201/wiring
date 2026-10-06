import { create } from "zustand";
import { customTemplate, isCreatable, template, type CreatableKind } from "../features/editor/templates";
import { isCustomId, parseCustomId, refKey } from "../shared/customId";
import { KIND_META } from "../features/graph/kindMeta";
import { logBuffer } from "../features/logs/logBuffer";
import { applyLogMessage, initialLogs, type LogsState } from "../features/logs/logsState";
import { commands } from "../shared/ipc/commands";
import type {
  AppError, ConnectionState, ContextInfo, CustomKind, CustomTable, Graph, GraphDelta, GraphEdge, Forward, GraphNode, K8sEvent, Kind, LogMessage, NamespaceScope, NodeId, ObjectDetails,
  HelmRelease, ResourceRef, Status, Table, TooLarge,
} from "../shared/ipc/types";
import { toAppError } from "../shared/ipc/types";
import { firstNamespace, inScope } from "../shared/scope";
import { settings } from "../shared/settings";
import { cancelTableRefresh } from "./tableRefresh";

export interface Toast { id: number; kind: AppError["kind"] | "info"; message: string }

export type EditorMode = "view" | "edit" | "review";

/** The YAML tab's state machine: view → edit (buffer diverges from original) → review (diff) → apply. */
export interface EditorState {
  mode: EditorMode;
  /** The text being edited; meaningful outside view mode only. */
  buffer: string;
  /** The YAML the buffer started from — the object's version as loaded (or last saved/reloaded). */
  original: string;
  /** The last failed apply/reload, shown as a banner in the tab; cleared on the next attempt. */
  error: AppError | null;
  saving: boolean;
}

export interface Details { nodeId: NodeId; data: ObjectDetails | null; events: K8sEvent[]; loading: boolean; editor: EditorState }

/** `custom`: creating a custom resource of that kind (then `kind` is unused). */
export interface CreateDialog { open: boolean; kind: CreatableKind; custom: ResourceRef | null; buffer: string; namespace: string; error: AppError | null; submitting: boolean }
export interface DeleteDialog { open: boolean; nodeId: NodeId | null }
/** "Discard your edits?" — opened by Cancel on a dirty buffer, or by a selection or namespace change
 *  while dirty (which then waits in `pendingSelect` / `pendingDeselect` / `pendingScope` until confirmed). */
export interface DiscardDialog { open: boolean; pendingSelect: NodeId | null; pendingDeselect: boolean; pendingScope: NamespaceScope | null }

/** The Actions menu, open for `nodeId` at viewport position (x, y). */
/** `flipY`: where the menu's bottom edge goes if it would overflow the viewport (the anchor's top). */
export interface ActionsMenu { nodeId: NodeId; x: number; y: number; flipY?: number }
export type ActionDialog =
  | { type: "scale"; nodeId: NodeId }
  | { type: "restart"; nodeId: NodeId }
  | { type: "rollback"; nodeId: NodeId; revision: number }
  | { type: "forward"; nodeId: NodeId };
export type DetailsTab = "overview" | "yaml" | "events" | "logs" | "terminal" | "history";

export function viewEditor(original = ""): EditorState {
  return { mode: "view", buffer: "", original, error: null, saving: false };
}

/** The template the dialog's current kind and namespace would start from. */
function dialogTemplate(d: Pick<CreateDialog, "kind" | "custom">, namespace: string): string {
  return d.custom ? customTemplate(d.custom, namespace) : template(d.kind, namespace);
}

const isDirty = (e: EditorState) => e.mode !== "view" && e.buffer !== e.original;

/** "Pod web-1" from `Pod/ns/web-1`, for toasts. */
export function describeNode(id: NodeId): string {
  const custom = parseCustomId(id);
  if (custom) return `${custom.kind} ${custom.name}`;
  const parts = id.split("/");
  const kind = parts[0] as Kind;
  return `${KIND_META[kind]?.label ?? kind} ${parts[parts.length - 1]}`;
}

/** What a delete toast names: "Pod web-1", or "7 pods of Deployment web" for a group. */
function describeDeleted(id: NodeId, groupCount: number): string {
  const parts = id.split("/");
  if (parts[0] !== "PodGroup") return describeNode(id);
  return `${groupCount} ${groupCount === 1 ? "pod" : "pods"} of ${parts[2]} ${parts[3]}`;
}

/** The centre pane: the graph, a per-kind table, a custom kind's table, or the Helm releases. */
export type View =
  | { name: "graph" }
  | { name: "table"; kind: Kind }
  | { name: "custom"; resource: ResourceRef }
  | { name: "helm" };

/** Bumped every time the graph should centre on `nodeId` (even re-focusing the same node). */
export interface FocusRequest { nodeId: NodeId; seq: number }

export interface Connection {
  state: ConnectionState;
  context: string | null;
  serverVersion: string | null;
  namespaces: string[];
  /** false when `namespaces` is only the context namespace: no "All namespaces", and the picker takes free text. */
  canListNamespaces: boolean;
  /** The watched namespaces; `null` until one is chosen. */
  scope: NamespaceScope | null;
  busy: boolean;
}

export interface GraphState {
  nodes: Map<NodeId, GraphNode>;
  edges: Map<string, GraphEdge>;
  /** false between select_namespaces and the next graph_snapshot — deltas are ignored meanwhile. */
  graphReady: boolean;
  selectedId: NodeId | null;
  details: Details | null;
  /** The details panel fills the window (the centre pane hidden); reset whenever the selection clears. */
  detailsMaximized: boolean;
  actionsMenu?: ActionsMenu | null;
  actionDialog?: ActionDialog | null;
}

export interface AppState extends GraphState {
  contexts: ContextInfo[];
  connection: Connection;
  hoveredId: NodeId | null;
  expandedGroups: Set<NodeId>;
  hiddenKinds: Set<Kind>;
  deniedKinds: Set<Kind>;
  /** Kinds listed only in some of the namespaces (forbidden cluster-wide, or in some of them). */
  partialKinds: Set<Kind>;
  /** Set instead of `nodes` when the scope has too many objects for a graph. */
  tooLarge: TooLarge | null;
  search: string;
  toasts: Toast[];
  pickerOpen: boolean;
  view: View;
  /** The kind of the most recent table view, so the Graph|Table switch can reopen it from Overview. */
  lastTableKind: Kind | null;
  sidebarCollapsed: boolean;
  tables: Map<Kind, Table>;
  /** Custom kinds from discovery; `null` until loaded for this connection. */
  customKinds: CustomKind[] | null;
  customKindsLoading: boolean;
  customKindsError: AppError | null;
  /** Rows of each custom kind's table by `refKey`, kept after leaving it for the navigator count. */
  customTables: Map<string, Table>;
  /** Why a custom kind's watch ended for good (RBAC revoked, kind no longer served), by `refKey`. */
  customTableErrors: Map<string, string>;
  /** Helm releases in the scope; `null` until fetched. */
  helmReleases: HelmRelease[] | null;
  focusRequest: FocusRequest | null;
  createDialog: CreateDialog;
  deleteDialog: DeleteDialog;
  discardDialog: DiscardDialog;
  /** The Logs tab's session metadata; the lines themselves live in `logBuffer`. */
  logs: LogsState;
  actionsMenu: ActionsMenu | null;
  actionDialog: ActionDialog | null;
  /** A scale/restart/rollback request is in flight; a second one is ignored. */
  actionBusy: boolean;
  /** A tab the details panel should switch to once it shows the selection (e.g. Rollback… → History). */
  requestedTab: DetailsTab | null;
  /** Running port-forwards, replaced by every `forwards_changed`. */
  forwards: Forward[];
  /** The header's port-forward popover. */
  forwardsOpen: boolean;

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
  selectScope: (scope: NamespaceScope) => Promise<void>;
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
  loadCustomKinds: (refresh?: boolean) => Promise<void>;
  showCustom: (resource: ResourceRef) => Promise<void>;
  refreshCustom: (resource: ResourceRef) => Promise<void>;
  applyCustomTable: (t: CustomTable) => void;
  showHelm: () => Promise<void>;
  refreshHelm: () => Promise<void>;
  focusInGraph: (id: NodeId) => Promise<void>;
  /** The canvas has centred on the requested node; drop the request so it does not replay. */
  clearFocusRequest: () => void;
  toggleSidebar: () => Promise<void>;
  // editing
  startEdit: () => void;
  setBuffer: (text: string) => void;
  /** Save: to the diff review, or an info toast when nothing changed. */
  reviewEdit: () => void;
  backToEdit: () => void;
  /** Send the buffer; `force` copies the server's current resourceVersion in first (overwrite after a conflict). */
  applyEdit: (force?: boolean) => Promise<void>;
  /** Back to view mode; asks first when the buffer is dirty. */
  cancelEdit: () => void;
  /** Refetch the object and restart the edit from the fresh YAML (after a conflict or a deletion). */
  reloadEdit: () => Promise<void>;
  confirmDiscard: () => void;
  cancelDiscard: () => void;
  // create
  openCreate: (kind?: CreatableKind) => void;
  setCreateKind: (kind: CreatableKind) => void;
  setCreateNamespace: (namespace: string) => void;
  setCreateBuffer: (text: string) => void;
  submitCreate: () => Promise<void>;
  closeCreate: () => void;
  // delete
  requestDelete: (nodeId: NodeId) => void;
  confirmDelete: () => Promise<void>;
  cancelDelete: () => void;
  // logs
  /** Open a log session for the node (restart when it is the current one, keeping the options). */
  startLogs: (nodeId: NodeId) => Promise<void>;
  stopLogs: () => Promise<void>;
  setLogsContainer: (container: string | null) => Promise<void>;
  toggleLogsPrevious: () => Promise<void>;
  toggleLogsTimestamps: () => Promise<void>;

  // workload actions
  /** Select `nodeId` and open the Actions menu for it at (x, y), unless a dirty editor asks first. */
  openActionsMenu: (nodeId: NodeId, x: number, y: number, flipY?: number) => void;
  closeActionsMenu: () => void;
  openActionDialog: (dialog: ActionDialog) => void;
  closeActionDialog: () => void;
  scaleObject: (nodeId: NodeId, replicas: number) => Promise<void>;
  restartObject: (nodeId: NodeId) => Promise<void>;
  rollbackObject: (nodeId: NodeId, revision: number) => Promise<void>;
  requestTab: (tab: DetailsTab) => void;
  consumeRequestedTab: () => void;
  toggleDetailsMaximized: () => void;

  // port-forwards
  setForwards: (forwards: Forward[]) => void;
  setForwardsOpen: (open: boolean) => void;
  /** Start a forward; resolves to the error (shown in the dialog, not toasted) or null. */
  startForward: (nodeId: NodeId, remotePort: number, localPort: number) => Promise<AppError | null>;
  stopForward: (id: number) => Promise<void>;
  openForward: (id: number) => Promise<void>;
}

let toastSeq = 0;
/** Log session generations. Module-level and monotonic: a `startLogs` still awaiting IPC across a
 *  session reset (the slice rebuilt, backend ids restarting at 1) must never share a generation
 *  with the next session, and a stop must orphan the channel it leaves behind. */
let logsGen = 0;

/** Kinds whose chips start off: RBAC objects and Nodes would crowd most graphs. */
export const DEFAULT_HIDDEN_KINDS: readonly Kind[] = ["Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "Node"];

export function initialState(): Omit<AppState, keyof Actions> {
  return {
    contexts: [],
    connection: { state: "disconnected", context: null, serverVersion: null, namespaces: [], canListNamespaces: true, scope: null, busy: false },
    nodes: new Map(),
    edges: new Map(),
    graphReady: false,
    selectedId: null,
    details: null,
    hoveredId: null,
    expandedGroups: new Set(),
    hiddenKinds: new Set(DEFAULT_HIDDEN_KINDS),
    deniedKinds: new Set(),
    partialKinds: new Set(),
    tooLarge: null,
    search: "",
    toasts: [],
    pickerOpen: false,
    view: { name: "graph" },
    lastTableKind: null,
    sidebarCollapsed: false,
    tables: new Map(),
    customKinds: null,
    customKindsLoading: false,
    customKindsError: null,
    customTables: new Map(),
    customTableErrors: new Map(),
    helmReleases: null,
    focusRequest: null,
    createDialog: { open: false, kind: "Deployment", custom: null, buffer: "", namespace: "", error: null, submitting: false },
    deleteDialog: { open: false, nodeId: null },
    discardDialog: { open: false, pendingSelect: null, pendingDeselect: false, pendingScope: null },
    logs: initialLogs(),
    actionsMenu: null,
    actionDialog: null,
    actionBusy: false,
    requestedTab: null,
    forwards: [],
    forwardsOpen: false,
    detailsMaximized: false,
  };
}

/** The state after the session is gone: graph, selection and connection reset, the context list,
 *  kind filters, toasts and the sidebar collapse preference kept. The Navigator lists the contexts
 *  to go to next; the modal picker opens only when there are none (its "add a kubeconfig" state). */
export function disconnectedState(s: AppState): Omit<AppState, keyof Actions> {
  const lost = lostEditsToast(s);
  return {
    ...initialState(), contexts: s.contexts, hiddenKinds: s.hiddenKinds, toasts: lost ? [...s.toasts, { id: ++toastSeq, ...lost }] : s.toasts,
    pickerOpen: s.contexts.length === 0, sidebarCollapsed: s.sidebarCollapsed,
  };
}

/** A session reset (disconnect, reconnect, a dropped connection) takes a dirty editor with it; this says so. */
function lostEditsToast(s: Pick<AppState, "details">): Omit<Toast, "id"> | null {
  if (!s.details || !isDirty(s.details.editor)) return null;
  return { kind: "info", message: `Unsaved edits to ${describeNode(s.details.nodeId)} were discarded` };
}

type Actions = Pick<AppState,
  | "applySnapshot" | "applyDelta" | "setObjectEvents" | "setConnectionState" | "loadContexts" | "addKubeconfig" | "connect"
  | "reconnect" | "disconnect" | "selectNamespace" | "selectScope" | "select" | "setHovered" | "toggleGroup" | "toggleKind" | "setSearch" | "toast"
  | "dismissToast" | "setPickerOpen" | "showGraph" | "showTable" | "refreshTable"
  | "loadCustomKinds" | "showCustom" | "refreshCustom" | "applyCustomTable" | "showHelm" | "refreshHelm" | "focusInGraph" | "clearFocusRequest"
  | "toggleSidebar" | "startEdit" | "setBuffer" | "reviewEdit" | "backToEdit" | "applyEdit" | "cancelEdit" | "reloadEdit"
  | "confirmDiscard" | "cancelDiscard" | "openCreate" | "setCreateKind" | "setCreateNamespace" | "setCreateBuffer" | "submitCreate" | "closeCreate"
  | "requestDelete" | "confirmDelete" | "cancelDelete" | "startLogs" | "stopLogs" | "setLogsContainer" | "toggleLogsPrevious"
  | "toggleLogsTimestamps" | "toggleDetailsMaximized" | "openActionsMenu" | "closeActionsMenu" | "openActionDialog"
  | "closeActionDialog" | "scaleObject" | "restartObject" | "rollbackObject" | "requestTab" | "consumeRequestedTab"
  | "setForwards" | "setForwardsOpen" | "startForward" | "stopForward" | "openForward">;

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

// The selection is not restricted to graph nodes: a table row can select a pod collapsed into a
// PodGroup or a hidden single ReplicaSet, neither of which is ever in `nodes`. So "not in nodes"
// does not mean "gone" — only a node the graph actually dropped clears the selection; a
// table-originated selection is checked against its rows in `refreshTable` instead.

export function applySnapshot<S extends GraphState>(s: S, g: Graph): S {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const edges = new Map(g.edges.map((e) => [e.id, e]));
  // A too-large snapshot carries no nodes at all: the selection's absence says nothing about it.
  const dropped = !g.tooLarge && s.selectedId !== null && s.nodes.has(s.selectedId) && !nodes.has(s.selectedId);
  return dropSelection({ ...s, nodes, edges, graphReady: true }, dropped);
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
  const dropped = s.selectedId !== null && d.removedNodes.includes(s.selectedId) && !nodes.has(s.selectedId);
  return dropSelection({ ...s, nodes, edges }, dropped);
}

/** The selected node is gone from the server. In view mode the selection clears; under an open
 *  editor the edits are worth more than the stale selection, so it stays and the tab tells. */
function dropSelection<S extends GraphState>(s: S, dropped: boolean): S {
  if (!dropped) return s;
  const gone = s.selectedId;
  const closed = {
    ...(s.actionsMenu?.nodeId === gone ? { actionsMenu: null } : {}),
    ...(s.actionDialog?.nodeId === gone ? { actionDialog: null } : {}),
  };
  if (s.details && s.details.editor.mode !== "view") {
    const error: AppError = { kind: "notFound", message: "This object was deleted on the server." };
    return { ...s, ...closed, details: { ...s.details, editor: { ...s.details.editor, error } } };
  }
  return { ...s, ...closed, selectedId: null, details: null, detailsMaximized: false, requestedTab: null };
}

// ---- store ----------------------------------------------------------------

/** A custom table's watch has no reader once another view replaces it. */
function leaveCustomView(prev: View, next: View): void {
  if (prev.name !== "custom") return;
  if (next.name === "custom" && refKey(next.resource) === refKey(prev.resource)) return;
  void commands.stopCustom().catch(() => {});
}

/** Custom kinds load generations: only the newest load owns `customKindsLoading` and the result, so
 *  a load left over from a previous connection neither lands nor ends the next one's. */
let customKindsGen = 0;

export const useAppStore = create<AppState>()((set, get) => ({
  ...initialState(),

  applySnapshot: (g) => {
    const before = get();
    set((s) => {
      // Belt and braces: a snapshot of the previous selection can still be queued behind
      // select_namespaces; nodes outside the current scope tell it apart.
      const scope = s.connection.scope;
      if (g.nodes.some((n) => n.namespace !== null && !inScope(scope, n.namespace))) return s;
      return { ...applySnapshot(s, g), tooLarge: g.tooLarge ?? null };
    });
    refreshDetailsIfTouched(before, get());
    const s = get();
    if (s.tooLarge && s.view.name === "graph") set({ view: { name: "table", kind: s.lastTableKind ?? "Deployment" } });
  },
  applyDelta: (d) => {
    const before = get();
    set((s) => applyDelta(s, d));
    refreshDetailsIfTouched(before, get());
    // A selection made before its node existed (an object just created here): fetch it now.
    const { selectedId, details } = get();
    if (selectedId !== null && details && details.data === null && !details.loading && d.addedNodes.some((n) => n.id === selectedId)) {
      void loadDetails(selectedId);
    }
  },
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
    const lost = lostEditsToast(get());
    customKindsGen++; // a custom kinds load of the session being replaced must not land in the next
    set((s) => ({ connection: { ...s.connection, busy: true } }));
    try {
      const info = await commands.connect(context);
      set({
        ...initialState(),
        contexts: get().contexts,
        hiddenKinds: get().hiddenKinds,
        sidebarCollapsed: get().sidebarCollapsed,
        connection: { state: "connected", context: info.context, serverVersion: info.serverVersion, namespaces: info.namespaces, canListNamespaces: info.canListNamespaces, scope: null, busy: false },
      });
      if (lost) get().toast(lost);
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
    const { context, scope } = get().connection;
    if (!context) return;
    const ok = await get().connect(context);
    if (ok && scope) await get().selectScope(scope);
  },

  disconnect: async () => {
    try {
      await commands.disconnect();
    } catch (e) {
      get().toast(toAppError(e));
    } finally {
      cancelDetailsRefresh();
      set(disconnectedState(get()));
    }
  },

  selectNamespace: (namespace) => get().selectScope([namespace]),

  selectScope: async (scope) => {
    const editor = get().details?.editor;
    if (editor && isDirty(editor)) {
      set({ discardDialog: { open: true, pendingSelect: null, pendingDeselect: false, pendingScope: scope } });
      return;
    }
    cancelTableRefresh();
    cancelDetailsRefresh();
    void get().stopLogs();
    const { expandedGroups } = get();
    const expanded = [...expandedGroups];
    // What a refused switch restores: the backend keeps the previous scope's watchers then.
    const before = get();
    const previous = {
      nodes: before.nodes, edges: before.edges, graphReady: before.graphReady, tooLarge: before.tooLarge,
      deniedKinds: before.deniedKinds, partialKinds: before.partialKinds, tables: before.tables, scope: before.connection.scope,
      customTables: before.customTables, customTableErrors: before.customTableErrors, helmReleases: before.helmReleases,
    };
    set((s) => ({
      nodes: new Map(), edges: new Map(), graphReady: false, tooLarge: null, selectedId: null, details: null, hoveredId: null,
      deniedKinds: new Set(), partialKinds: new Set(), tables: new Map(), focusRequest: null, connection: { ...s.connection, scope },
      customTables: new Map(), customTableErrors: new Map(), helmReleases: null,
      deleteDialog: initialState().deleteDialog, discardDialog: initialState().discardDialog, detailsMaximized: false,
      actionsMenu: null, actionDialog: null, requestedTab: null,
    }));
    try {
      await commands.selectNamespaces(scope, expanded);
    } catch (e) {
      const { scope: prevScope, ...graph } = previous;
      if (get().connection.scope === scope) set((s) => ({ ...graph, connection: { ...s.connection, scope: prevScope } }));
      get().toast(toAppError(e));
      return;
    }
    // Remembered only once the backend accepted it (and not while the discard dialog was up).
    const { connection } = get();
    if (connection.context && connection.scope === scope) void settings.setLastScope(connection.context, scope);
    try {
      const [denied, partial] = await Promise.all([commands.deniedKinds(), commands.partialKinds()]);
      // Only if this is still the current selection - a newer one owns these sets now.
      if (get().connection.scope === scope) set({ deniedKinds: new Set(denied), partialKinds: new Set(partial) });
      // An open table is refetched by the graph_snapshot handler once the backend has the new
      // objects; fetching here would race the watchers and land an empty table.
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  select: async (id) => {
    if (id === get().selectedId) return;
    const editor = get().details?.editor;
    if (editor && isDirty(editor)) {
      set({ discardDialog: { open: true, pendingSelect: id, pendingDeselect: id === null, pendingScope: null } });
      return;
    }
    // The switch is really happening: the logs of the node being left go with it.
    if (get().logs.nodeId !== null && get().logs.nodeId !== id) void get().stopLogs();
    if (id === null) {
      cancelDetailsRefresh();
      set({ selectedId: null, details: null, detailsMaximized: false });
      await commands.watchEvents(null).catch(() => {});
      return;
    }
    const error = await loadDetails(id);
    // An object just created here may not have reached the graph through the watch yet, so
    // get_object does not know it either: `applyDelta` fetches the details once the node arrives.
    if (error && !(error.kind === "notFound" && !get().nodes.has(id))) get().toast(error);
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

  showGraph: () => {
    leaveCustomView(get().view, { name: "graph" });
    set({ view: { name: "graph" } });
  },

  showTable: async (kind) => {
    leaveCustomView(get().view, { name: "table", kind });
    set({ view: { name: "table", kind }, lastTableKind: kind });
    if (get().deniedKinds.has(kind)) return; // the table shows its RBAC state; the fetch would only fail
    await get().refreshTable(kind);
  },

  refreshTable: async (kind) => {
    const scope = get().connection.scope;
    const onTable = (v: View) => v.name === "table" && v.kind === kind;
    const wasOnTable = onTable(get().view);
    try {
      const table = await commands.listRows(kind);
      // The namespace moved on while this fetch was in flight — its rows are stale.
      if (scope === null || get().connection.scope !== scope) return;
      // The user left this table while its refetch was in flight; showing it again refetches.
      if (wasOnTable && !onTable(get().view)) return;
      set((s) => {
        const tables = new Map(s.tables);
        tables.set(kind, table);
        // A selection made from the table on screen whose row is gone: the graph reducers cannot
        // tell (the object may never have been a graph node), so it is this fetch's job.
        const onScreen = s.view.name === "table" && s.view.kind === kind;
        const orphaned = onScreen && s.selectedId !== null && s.selectedId.startsWith(`${kind}/`)
          && !table.rows.some((r) => r.nodeId === s.selectedId);
        return orphaned ? dropSelection({ ...s, tables }, true) : { tables };
      });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  loadCustomKinds: async (refresh = false) => {
    if (get().customKindsLoading) return;
    const gen = ++customKindsGen;
    const context = get().connection.context;
    const current = () => gen === customKindsGen && get().connection.context === context;
    set({ customKindsLoading: true, customKindsError: null });
    try {
      const kinds = await (refresh ? commands.refreshCustomKinds() : commands.customKinds());
      // `?? []`: an answer without a list still counts as loaded, or the navigator would ask again forever.
      if (current()) set({ customKinds: kinds ?? [] });
    } catch (e) {
      if (current()) set({ customKindsError: toAppError(e) });
    } finally {
      if (gen === customKindsGen) set({ customKindsLoading: false });
    }
  },

  showCustom: async (resource) => {
    const next: View = { name: "custom", resource };
    leaveCustomView(get().view, next);
    set({ view: next });
    await get().refreshCustom(resource);
  },

  refreshCustom: async (resource) => {
    const scope = get().connection.scope;
    const key = refKey(resource);
    const current = () => {
      const view = get().view;
      return scope !== null && get().connection.scope === scope && view.name === "custom" && refKey(view.resource) === key;
    };
    try {
      const t = await commands.listCustom(resource);
      if (scope === null || get().connection.scope !== scope) return;
      const view = get().view;
      if (view.name !== "custom") {
        // Left while listing: the watch list_custom just started has no reader.
        void commands.stopCustom().catch(() => {});
        return;
      }
      if (refKey(view.resource) !== key) {
        // Another kind was opened meanwhile, and this late answer replaced its watch; restart it.
        void get().refreshCustom(view.resource);
        return;
      }
      get().applyCustomTable(t);
    } catch (e) {
      // A failure of a table left (or of another scope) is nobody's news.
      if (current()) get().toast(toAppError(e));
    }
  },

  applyCustomTable: (t) =>
    set((s) => {
      const key = refKey(t.resource);
      const customTables = new Map(s.customTables);
      customTables.set(key, t.table);
      const customTableErrors = new Map(s.customTableErrors);
      if (t.error) customTableErrors.set(key, t.error); else customTableErrors.delete(key);
      // Deleted by someone else: the selected row was in this kind's previous rows and is not now. A
      // just-created object is selected before its row arrives, and a terminal error empties the
      // rows without deleting anything; neither drops the selection.
      const sel = s.selectedId;
      const dropped = sel !== null && !t.error && (s.customTables.get(key)?.rows.some((r) => r.nodeId === sel) ?? false)
        && !t.table.rows.some((r) => r.nodeId === sel);
      return dropSelection({ ...s, customTables, customTableErrors }, dropped);
    }),

  showHelm: async () => {
    leaveCustomView(get().view, { name: "helm" });
    set({ view: { name: "helm" } });
    await get().refreshHelm();
  },

  refreshHelm: async () => {
    const scope = get().connection.scope;
    try {
      const releases = await commands.helmReleases();
      if (scope === null || get().connection.scope !== scope) return;
      set({ helmReleases: releases ?? [] }); // as with custom kinds: a missing list must not re-trigger the fetch
    } catch (e) {
      if (scope !== null && get().connection.scope === scope) get().toast(toAppError(e));
    }
  },

  focusInGraph: async (id) => {
    if (get().tooLarge) {
      get().toast({ kind: "info", message: "The graph is too large to show \u2014 use the table" });
      return;
    }
    const target = get().nodes.get(id);
    if (!target) {
      const name = id.split("/").pop() ?? id;
      get().toast({ kind: "info", message: `${name} is not on the graph (hidden or collapsed into a group)` });
      return;
    }
    if (get().hiddenKinds.has(target.kind)) get().toggleKind(target.kind); // a hidden node cannot be centred on
    leaveCustomView(get().view, { name: "graph" });
    // The request is in place before the canvas mounts, so its whole-graph fit yields to the focus.
    set((s) => ({ view: { name: "graph" }, focusRequest: { nodeId: id, seq: (s.focusRequest?.seq ?? 0) + 1 } }));
    await get().select(id);
  },

  clearFocusRequest: () => set({ focusRequest: null }),

  toggleSidebar: async () => {
    const next = !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    await settings.setSidebarCollapsed(next);
  },

  // ---- editing --------------------------------------------------------------

  startEdit: () =>
    set((s) => {
      if (!s.details?.data || s.details.editor.mode !== "view") return {};
      const original = s.details.editor.original;
      return { details: { ...s.details, editor: { mode: "edit", buffer: original, original, error: null, saving: false } } };
    }),

  setBuffer: (buffer) => set((s) => (s.details && s.details.editor.mode !== "view" ? { details: { ...s.details, editor: { ...s.details.editor, buffer } } } : {})),

  reviewEdit: () => {
    const d = get().details;
    if (!d || d.editor.mode !== "edit") return;
    if (d.editor.buffer === d.editor.original) {
      get().toast({ kind: "info", message: "No changes" });
      return;
    }
    set({ details: { ...d, editor: { ...d.editor, mode: "review" } } });
  },

  backToEdit: () => set((s) => (s.details?.editor.mode === "review" && !s.details.editor.saving ? { details: { ...s.details, editor: { ...s.details.editor, mode: "edit" } } } : {})),

  applyEdit: async (force = false) => {
    const d = get().details;
    if (!d || d.editor.mode === "view" || d.editor.saving) return;
    const { nodeId } = d;
    const yaml = d.editor.buffer;
    set({ details: { ...d, editor: { ...d.editor, saving: true, error: null } } });
    // The result belongs to this session only: still on the node, still marked saving. Anything
    // else (a discard, a delete, a fresh edit after moving away and back) has ended it meanwhile.
    const live = (s: AppState) => s.details?.nodeId === nodeId && s.details.editor.saving;
    try {
      const data = await commands.updateObject(nodeId, yaml, force);
      set((s) => (live(s) ? { details: { ...s.details!, data, editor: viewEditor(data.yaml) } } : {}));
      get().toast({ kind: "info", message: `Saved ${describeNode(nodeId)}` });
    } catch (e) {
      const error = toAppError(e);
      // Conflicts and validation failures are the tab's banner; anything else is the usual toast too.
      set((s) => (live(s) ? { details: { ...s.details!, editor: { ...s.details!.editor, mode: "edit", saving: false, error } } } : {}));
      if (error.kind !== "conflict" && error.kind !== "invalid") get().toast(error);
    }
  },

  cancelEdit: () => {
    const d = get().details;
    if (!d || d.editor.mode === "view" || d.editor.saving) return;
    if (isDirty(d.editor)) {
      set({ discardDialog: { open: true, pendingSelect: null, pendingDeselect: false, pendingScope: null } });
      return;
    }
    set({ details: { ...d, editor: viewEditor(d.editor.original) } });
  },

  reloadEdit: async () => {
    const d = get().details;
    if (!d || d.editor.mode === "view") return;
    const { nodeId } = d;
    // Only while the edit is still open on this node; a cancel meanwhile must not reopen it.
    const live = (s: AppState) => s.details?.nodeId === nodeId && s.details.editor.mode !== "view";
    try {
      const data = await commands.getObject(nodeId);
      set((s) => (live(s)
        ? { details: { ...s.details!, data, editor: { mode: "edit", buffer: data.yaml, original: data.yaml, error: null, saving: false } } }
        : {}));
    } catch (e) {
      const error = toAppError(e);
      set((s) => (live(s) ? { details: { ...s.details!, editor: { ...s.details!.editor, error } } } : {}));
    }
  },

  confirmDiscard: () => {
    const { discardDialog, details } = get();
    if (!discardDialog.open) return;
    set({
      discardDialog: initialState().discardDialog,
      ...(details ? { details: { ...details, editor: viewEditor(details.editor.original) } } : {}),
    });
    if (discardDialog.pendingScope !== null) void get().selectScope(discardDialog.pendingScope);
    else if (discardDialog.pendingSelect !== null || discardDialog.pendingDeselect) void get().select(discardDialog.pendingSelect);
  },

  cancelDiscard: () => set({ discardDialog: initialState().discardDialog }),

  // ---- create ---------------------------------------------------------------

  openCreate: (requested) =>
    set((s) => {
      const namespace = firstNamespace(s.connection.scope, s.connection.namespaces) ?? "default";
      // Creating from a custom kind's table starts from that kind.
      const custom = !requested && s.view.name === "custom" ? s.view.resource : null;
      // Creating from a kind's table most likely means "one more of these".
      const tableKind = s.view.name === "table" && isCreatable(s.view.kind) ? s.view.kind : null;
      const kind = requested ?? tableKind ?? "Deployment";
      return { createDialog: { open: true, kind, custom, buffer: dialogTemplate({ kind, custom }, namespace), namespace, error: null, submitting: false } };
    }),

  setCreateKind: (kind) =>
    set((s) => {
      const d = s.createDialog;
      // Re-template unless the user has started typing into the previous one.
      const untouched = d.buffer === "" || d.buffer === dialogTemplate(d, d.namespace);
      return { createDialog: { ...d, kind, custom: null, buffer: untouched ? template(kind, d.namespace) : d.buffer } };
    }),

  setCreateNamespace: (namespace) =>
    set((s) => {
      const d = s.createDialog;
      const untouched = d.buffer === "" || d.buffer === dialogTemplate(d, d.namespace);
      return { createDialog: { ...d, namespace, buffer: untouched ? dialogTemplate(d, namespace) : d.buffer } };
    }),

  setCreateBuffer: (buffer) => set((s) => ({ createDialog: { ...s.createDialog, buffer } })),

  submitCreate: async () => {
    const d = get().createDialog;
    if (!d.open || d.submitting) return;
    set({ createDialog: { ...d, submitting: true, error: null } });
    let nodeId: NodeId;
    try {
      nodeId = await commands.createObject(d.namespace, d.buffer);
    } catch (e) {
      set((s) => ({ createDialog: { ...s.createDialog, submitting: false, error: toAppError(e) } }));
      return;
    }
    set({ createDialog: initialState().createDialog });
    get().toast({ kind: "info", message: `Created ${describeNode(nodeId)}` });
    // `select` asks first when another object's edits are dirty, and tolerates the new object not
    // having reached the graph through the watch yet.
    await get().select(nodeId);
  },

  closeCreate: () => set({ createDialog: initialState().createDialog }),

  // ---- delete ---------------------------------------------------------------

  requestDelete: (nodeId) => set({ deleteDialog: { open: true, nodeId } }),

  confirmDelete: async () => {
    const { nodeId } = get().deleteDialog;
    set({ deleteDialog: initialState().deleteDialog });
    if (nodeId === null) return;
    // Read the member count before the watch stream shrinks or removes the group.
    const count = get().nodes.get(nodeId)?.group?.count ?? 0;
    try {
      await commands.deleteObject(nodeId);
      // Its editor has nothing left to save; back to view, and the watch's removal clears the selection.
      set((s) => (s.details?.nodeId === nodeId ? { details: { ...s.details, editor: viewEditor(s.details.editor.original) } } : {}));
      // A custom resource off the graph has no watch removal to clear it.
      if (isCustomId(nodeId)) set((s) => dropSelection(s, s.selectedId === nodeId));
      get().toast({ kind: "info", message: `Deleted ${describeDeleted(nodeId, count)}` });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  cancelDelete: () => set({ deleteDialog: initialState().deleteDialog }),

  // ---- logs ------------------------------------------------------------------

  startLogs: async (nodeId) => {
    const prev = get().logs;
    if (prev.sessionId !== null) commands.stopLogs(prev.sessionId).catch(() => {});
    logBuffer.clear();
    const gen = ++logsGen;
    // Keep the options (container/previous/timestamps) when restarting on the same node.
    const same = prev.nodeId === nodeId;
    set({
      logs: {
        ...initialLogs(), gen, nodeId, status: "starting",
        container: same ? prev.container : null, previous: same ? prev.previous : false, timestamps: same ? prev.timestamps : false,
      },
    });
    const { container, previous, timestamps } = get().logs;
    const onMessage = (m: LogMessage) => {
      const s = get().logs;
      if (s.gen !== gen) return; // a newer session owns the tab
      if (m.type === "lines") { logBuffer.append(m.lines); return; }
      set({ logs: applyLogMessage(s, m) });
    };
    try {
      const sessionId = await commands.startLogs({ nodeId, container, previous, timestamps }, onMessage);
      if (get().logs.gen === gen) set((s) => ({ logs: { ...s.logs, sessionId } }));
      else commands.stopLogs(sessionId).catch(() => {}); // superseded while starting: nobody holds this id
    } catch (e) {
      if (get().logs.gen !== gen) return; // superseded meanwhile: its failure is nobody's news
      set({ logs: { ...initialLogs(), gen } });
      get().toast(toAppError(e));
    }
  },

  stopLogs: async () => {
    const { sessionId } = get().logs;
    // A fresh generation orphans the stopped channel: batches the webview already queued from it
    // must not land in an idle slice.
    set({ logs: { ...initialLogs(), gen: ++logsGen } });
    logBuffer.clear();
    if (sessionId !== null) await commands.stopLogs(sessionId).catch(() => {});
  },

  // The three option actions set the new value first and restart through `startLogs` (not
  // `stopLogs`), which reads the options back for the same node.

  setLogsContainer: async (container) => {
    const { nodeId } = get().logs;
    if (nodeId === null) return;
    set((s) => ({ logs: { ...s.logs, container } }));
    await get().startLogs(nodeId);
  },

  toggleLogsPrevious: async () => {
    const { nodeId } = get().logs;
    if (nodeId === null) return;
    set((s) => ({ logs: { ...s.logs, previous: !s.logs.previous } }));
    await get().startLogs(nodeId);
  },

  toggleLogsTimestamps: async () => {
    const { nodeId } = get().logs;
    if (nodeId === null) return;
    set((s) => ({ logs: { ...s.logs, timestamps: !s.logs.timestamps } }));
    await get().startLogs(nodeId);
  },

  toggleDetailsMaximized: () => set((s) => ({ detailsMaximized: !s.detailsMaximized })),
  openActionsMenu: (nodeId, x, y, flipY) => {
    void get().select(nodeId);
    // `select` decides synchronously whether a dirty editor must be confirmed first; then no menu.
    if (get().discardDialog.open) return;
    set({ actionsMenu: flipY === undefined ? { nodeId, x, y } : { nodeId, x, y, flipY } });
  },
  closeActionsMenu: () => set({ actionsMenu: null }),
  openActionDialog: (dialog) => set({ actionDialog: dialog }),
  closeActionDialog: () => set({ actionDialog: null }),
  setForwards: (forwards) => set((s) => ({ forwards, forwardsOpen: forwards.length > 0 && s.forwardsOpen })),
  setForwardsOpen: (forwardsOpen) => set({ forwardsOpen }),
  startForward: async (nodeId, remotePort, localPort) => {
    try {
      const f = await commands.startForward(nodeId, remotePort, localPort);
      set((s) => ({
        // `forwards_changed` may have listed it already (with a fresher status).
        forwards: s.forwards.some((x) => x.id === f.id) ? s.forwards : [...s.forwards, f],
        actionDialog: s.actionDialog?.type === "forward" && s.actionDialog.nodeId === nodeId ? null : s.actionDialog,
      }));
      get().toast({ kind: "info", message: `Forwarding 127.0.0.1:${f.localPort} → ${f.targetLabel}:${f.remotePort}` });
      return null;
    } catch (e) {
      return toAppError(e);
    }
  },
  stopForward: async (id) => {
    try {
      await commands.stopForward(id);
      set((s) => {
        const forwards = s.forwards.filter((f) => f.id !== id);
        return { forwards, forwardsOpen: forwards.length > 0 && s.forwardsOpen };
      });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },
  openForward: async (id) => {
    try {
      await commands.openForward(id);
    } catch (e) {
      get().toast(toAppError(e));
    }
  },
  scaleObject: (nodeId, replicas) =>
    runAction(nodeId, () => commands.scaleObject(nodeId, replicas), `Scaled ${describeNode(nodeId)} to ${replicas}`),
  restartObject: (nodeId) => runAction(nodeId, () => commands.restartObject(nodeId), `Restarted ${describeNode(nodeId)}`),
  rollbackObject: (nodeId, revision) =>
    runAction(nodeId, () => commands.rollbackObject(nodeId, revision), `Rolled ${describeNode(nodeId)} back to revision ${revision}`),
  requestTab: (tab) => set({ requestedTab: tab }),
  consumeRequestedTab: () => set({ requestedTab: null }),
}));

/** A scale/restart/rollback write. The open details take the returned object unless an edit is in
 *  progress there (its own conflict handling covers that); the dialog closes on success (unless a newer
 *  one replaced it meanwhile); on failure it stays open for a retry. A toast reports the outcome. */
async function runAction(nodeId: NodeId, call: () => Promise<ObjectDetails>, done: string): Promise<void> {
  if (useAppStore.getState().actionBusy) return;
  const dialog = useAppStore.getState().actionDialog;
  useAppStore.setState({ actionBusy: true });
  try {
    const data = await call();
    useAppStore.setState((s) => ({
      actionBusy: false,
      ...(s.actionDialog === dialog ? { actionDialog: null } : {}),
      ...(s.details?.nodeId === nodeId && s.details.editor.mode === "view" ? { details: { ...s.details, data, editor: viewEditor(data.yaml) } } : {}),
    }));
    useAppStore.getState().toast({ kind: "info", message: done });
  } catch (e) {
    useAppStore.setState({ actionBusy: false });
    useAppStore.getState().toast(toAppError(e));
  }
}

const DETAILS_REFRESH_MS = 1000;
let detailsRefreshAt = 0;
let detailsRefreshTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelDetailsRefresh(): void {
  if (detailsRefreshTimer !== null) clearTimeout(detailsRefreshTimer);
  detailsRefreshTimer = null;
  detailsRefreshAt = 0;
}

/** Reload the open details soon (throttled like graph-driven reloads), e.g. after a metrics sample. */
export function requestDetailsRefresh(): void {
  scheduleDetailsRefresh();
}

/** The graph changed under the open details: the selected node was replaced, or an edge touching
 *  it came or went (its Related list and summary derive from them). */
function refreshDetailsIfTouched(before: GraphState, after: GraphState): void {
  const id = after.selectedId;
  if (id === null || !after.nodes.has(id) || before.nodes.get(id) === undefined) return;
  const touching = (g: GraphState) => [...g.edges.values()].filter((e) => e.source === id || e.target === id).map((e) => e.id).sort().join("\n");
  if (before.nodes.get(id) !== after.nodes.get(id) || touching(before) !== touching(after)) scheduleDetailsRefresh();
}

/** Reload the open details' object at most once a second (a leading reload, then one trailing).
 *  View mode only, so an edit or review in progress is never clobbered; events stay with the
 *  existing watch. */
function scheduleDetailsRefresh(): void {
  if (detailsRefreshTimer !== null) return;
  const wait = detailsRefreshAt + DETAILS_REFRESH_MS - Date.now();
  if (wait > 0) {
    detailsRefreshTimer = setTimeout(() => { detailsRefreshTimer = null; void reloadDetails(); }, wait);
  } else {
    void reloadDetails();
  }
}

function selectionInDetailsPanel(): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.toString() === "") return false;
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  return !!el?.closest("[data-details-panel]");
}

async function reloadDetails(): Promise<void> {
  const { selectedId: id, details } = useAppStore.getState();
  if (id === null || !details || details.nodeId !== id || !details.data || details.loading || details.editor.mode !== "view") return;
  detailsRefreshAt = Date.now();
  try {
    const data = await commands.getObject(id);
    useAppStore.setState((s) => {
      if (s.selectedId !== id || s.details?.nodeId !== id || s.details.editor.mode !== "view") return {};
      // Nothing new: leave the state alone so the YAML tab is not re-rendered every second.
      if (s.details.data && JSON.stringify(s.details.data) === JSON.stringify(data)) return {};
      // Do not swap the text out from under a selection being made in the panel; the next change retries.
      if (selectionInDetailsPanel()) return {};
      return { details: { ...s.details, data, editor: viewEditor(data.yaml) } };
    });
  } catch {
    // The next change retries; a failed background refresh is not worth a toast.
  }
}

/** Select `id` and fetch its details + events. Returns the fetch error (not toasted) or null;
 *  a stale result — the selection moved on meanwhile — is dropped either way. */
async function loadDetails(id: NodeId): Promise<AppError | null> {
  const { setState: set } = useAppStore;
  set({ selectedId: id, details: { nodeId: id, data: null, events: [], loading: true, editor: viewEditor() } });
  try {
    const [data] = await Promise.all([commands.getObject(id), commands.watchEvents(id)]);
    set((s) => (s.selectedId === id ? { details: { nodeId: id, data, events: s.details?.events ?? [], loading: false, editor: viewEditor(data.yaml) } } : {}));
    return null;
  } catch (e) {
    set((s) => (s.selectedId === id ? { details: { nodeId: id, data: null, events: [], loading: false, editor: viewEditor() } } : {}));
    return toAppError(e);
  }
}
