import { beforeEach, describe, expect, it, vi } from "vitest";
import graphFixture from "../shared/ipc/fixtures/graph.json";
import type { Graph, GraphDelta, GraphNode, Kind } from "../shared/ipc/types";

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_object") return { yaml: "kind: Pod\n", summary: [["Name", "web-1"]], related: [] };
    if (cmd === "denied_kinds") return ["Secret"];
    if (cmd === "connect") return { context: "prod", serverVersion: "v1.33.0", namespaces: ["default", "payments"] };
    return null;
  }),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../shared/settings", () => ({
  settings: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    getLastNamespace: vi.fn(async () => null),
    setLastNamespace: vi.fn(async () => {}),
    getSidebarCollapsed: vi.fn(async () => false),
    setSidebarCollapsed: vi.fn(async () => {}),
  },
}));

import { invoke } from "../shared/ipc/tauri";
import { template } from "../features/editor/templates";
import { applyDelta, applySnapshot, disconnectedState, initialState, kindStats, useAppStore, viewEditor, type AppState } from "./store";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: "Pod", namespace: "p", name: id.split("/").pop()!, status: "ok", badges: ["Running"], group: null, ...over,
});

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockClear();
});

describe("graph reducers", () => {
  it("snapshot replaces everything and marks the graph ready", () => {
    const s = applySnapshot(initialState(), graphFixture as Graph);
    expect(s.nodes.size).toBe(2);
    expect(s.edges.size).toBe(1);
    expect(s.graphReady).toBe(true);
  });

  it("delta adds, updates and removes; selection survives when its node stays", () => {
    let s = applySnapshot(initialState(), { nodes: [node("Pod/p/a"), node("Pod/p/b")], edges: [] });
    s = { ...s, selectedId: "Pod/p/a" };
    const delta: GraphDelta = {
      addedNodes: [node("Pod/p/c")],
      updatedNodes: [node("Pod/p/a", { status: "err", badges: ["CrashLoopBackOff"] })],
      removedNodes: ["Pod/p/b"],
      addedEdges: [{ id: "Pod/p/a->Pod/p/c:owns", source: "Pod/p/a", target: "Pod/p/c", relation: "owns" }],
      removedEdges: [],
    };
    s = applyDelta(s, delta);
    expect([...s.nodes.keys()].sort()).toEqual(["Pod/p/a", "Pod/p/c"]);
    expect(s.nodes.get("Pod/p/a")?.status).toBe("err");
    expect(s.edges.size).toBe(1);
    expect(s.selectedId).toBe("Pod/p/a");
  });

  it("delta removing the selected node clears selection and details", () => {
    let s = applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] });
    s = { ...s, selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data: null, events: [], loading: false, editor: viewEditor() } };
    s = applyDelta(s, { addedNodes: [], updatedNodes: [], removedNodes: ["Pod/p/a"], addedEdges: [], removedEdges: [] });
    expect(s.selectedId).toBeNull();
    expect(s.details).toBeNull();
  });

  it("delta leaves a table-originated selection alone", () => {
    // A pod collapsed into a PodGroup (or a hidden single ReplicaSet) is selected from a table:
    // it is never a graph node, so "not in nodes" must not mean "gone".
    let s = applySnapshot(initialState(), { nodes: [node("PodGroup/p/Deployment/web", { kind: "PodGroup", group: { count: 3, ok: 3, warn: 0, err: 0 } })], edges: [] });
    s = { ...s, selectedId: "Pod/p/web-1", details: { nodeId: "Pod/p/web-1", data: null, events: [], loading: false, editor: viewEditor() } };
    s = applyDelta(s, { addedNodes: [], updatedNodes: [node("PodGroup/p/Deployment/web", { kind: "PodGroup", group: { count: 4, ok: 4, warn: 0, err: 0 } })], removedNodes: [], addedEdges: [], removedEdges: [] });
    expect(s.selectedId).toBe("Pod/p/web-1");
    expect(s.details?.nodeId).toBe("Pod/p/web-1");
  });

  it("snapshot dropping a graph node clears selection", () => {
    let s = applySnapshot(initialState(), { nodes: [node("Pod/p/a"), node("Pod/p/b")], edges: [] });
    s = { ...s, selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data: null, events: [], loading: false, editor: viewEditor() } };
    s = applySnapshot(s, { nodes: [node("Pod/p/b")], edges: [] });
    expect(s.selectedId).toBeNull();
    expect(s.details).toBeNull();
  });

  it("snapshot leaves a selection that was never a graph node alone", () => {
    let s = applySnapshot(initialState(), { nodes: [node("Pod/p/b")], edges: [] });
    s = { ...s, selectedId: "Pod/p/collapsed", details: { nodeId: "Pod/p/collapsed", data: null, events: [], loading: false, editor: viewEditor() } };
    s = applySnapshot(s, { nodes: [node("Pod/p/b")], edges: [] });
    expect(s.selectedId).toBe("Pod/p/collapsed");
  });

  it("deltas are ignored until a snapshot arrived", () => {
    const s = applyDelta(initialState(), { addedNodes: [node("Pod/p/a")], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });
    expect(s.nodes.size).toBe(0);
  });
});

describe("actions", () => {
  it("select loads details and starts the events watcher; deselect stops it", async () => {
    useAppStore.setState(applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }));
    await useAppStore.getState().select("Pod/p/a");
    expect(useAppStore.getState().details?.data?.yaml).toBe("kind: Pod\n");
    expect(invoke).toHaveBeenCalledWith("get_object", { nodeId: "Pod/p/a" });
    expect(invoke).toHaveBeenCalledWith("watch_events", { nodeId: "Pod/p/a" });
    await useAppStore.getState().select(null);
    expect(invoke).toHaveBeenCalledWith("watch_events", { nodeId: null });
    expect(useAppStore.getState().details).toBeNull();
  });

  it("select is a no-op when the node is already selected, and so is deselecting nothing", async () => {
    useAppStore.setState(applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }));
    await useAppStore.getState().select(null);
    expect(invoke).not.toHaveBeenCalled();
    await useAppStore.getState().select("Pod/p/a");
    const details = useAppStore.getState().details;
    vi.mocked(invoke).mockClear();
    await useAppStore.getState().select("Pod/p/a");
    expect(invoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().details).toBe(details); // not reset to loading
  });

  it("the store ignores a snapshot from a namespace that is no longer selected", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespace: "b" } });
    useAppStore.getState().applySnapshot({ nodes: [node("Pod/a/x", { namespace: "a" })], edges: [] });
    expect(useAppStore.getState().nodes.size).toBe(0);
    expect(useAppStore.getState().graphReady).toBe(false);

    // Cluster-scoped nodes carry no namespace; a snapshot of only those is accepted.
    useAppStore.getState().applySnapshot({ nodes: [node("PersistentVolume/pv", { kind: "PersistentVolume", namespace: null })], edges: [] });
    expect(useAppStore.getState().nodes.size).toBe(1);
    useAppStore.getState().applySnapshot({ nodes: [node("PersistentVolume/pv", { kind: "PersistentVolume", namespace: null }), node("Pod/b/y", { namespace: "b" })], edges: [] });
    expect(useAppStore.getState().nodes.size).toBe(2);
  });

  it("selectNamespace drops the denied-kinds result of a superseded selection", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod" } });
    const first = useAppStore.getState().selectNamespace("a");
    // A newer selection lands while the first one is still talking to the backend.
    useAppStore.setState((s) => ({ connection: { ...s.connection, namespace: "b" } }));
    await first;
    expect(useAppStore.getState().deniedKinds.size).toBe(0);
  });

  it("selectNamespace clears the graph, resets readiness and asks the backend", async () => {
    useAppStore.setState({ ...applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }), connection: { ...initialState().connection, context: "prod" } });
    await useAppStore.getState().selectNamespace("payments");
    const s = useAppStore.getState();
    expect(s.nodes.size).toBe(0);
    expect(s.graphReady).toBe(false);
    expect(s.connection.namespace).toBe("payments");
    expect(invoke).toHaveBeenCalledWith("select_namespace", { namespace: "payments", expandedGroups: [] });
    expect([...s.deniedKinds]).toEqual(["Secret"]);
  });

  it("selectNamespace drops a pending focus request", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod" }, focusRequest: { nodeId: "Pod/a/x", seq: 3 } });
    await useAppStore.getState().selectNamespace("b");
    expect(useAppStore.getState().focusRequest).toBeNull();
  });

  it("clearFocusRequest consumes the request", () => {
    useAppStore.setState({ focusRequest: { nodeId: "Pod/a/x", seq: 3 } });
    useAppStore.getState().clearFocusRequest();
    expect(useAppStore.getState().focusRequest).toBeNull();
  });

  it("toggleGroup updates expandedGroups and pushes them to the backend", async () => {
    await useAppStore.getState().toggleGroup("PodGroup/p/Deployment/web");
    expect([...useAppStore.getState().expandedGroups]).toEqual(["PodGroup/p/Deployment/web"]);
    expect(invoke).toHaveBeenCalledWith("set_expanded_groups", { expandedGroups: ["PodGroup/p/Deployment/web"] });
    await useAppStore.getState().toggleGroup("PodGroup/p/Deployment/web");
    expect(useAppStore.getState().expandedGroups.size).toBe(0);
  });

  it("connect stores connection info", async () => {
    await useAppStore.getState().connect("prod");
    const c = useAppStore.getState().connection;
    expect(c.context).toBe("prod");
    expect(c.serverVersion).toBe("v1.33.0");
    expect(c.namespaces).toEqual(["default", "payments"]);
    expect(c.state).toBe("connected");
  });

  it("connect failure becomes a toast and leaves the app disconnected", async () => {
    // The backend tears the previous session down before dialling the new context, so a failed
    // connect from a connected state must not pretend the old connection is still alive.
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }),
      connection: { ...initialState().connection, state: "connected", context: "staging", namespace: "payments" },
      toasts: [{ id: 1, kind: "info", message: "earlier" }],
    });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "auth", message: "exec plugin missing" });
    expect(await useAppStore.getState().connect("prod")).toBe(false);
    const s = useAppStore.getState();
    expect(s.connection).toEqual(initialState().connection);
    expect(s.nodes.size).toBe(0);
    expect(s.pickerOpen).toBe(true);
    expect(s.toasts).toHaveLength(2);
    expect(s.toasts[0]).toMatchObject({ message: "earlier" });
    expect(s.toasts[1]).toMatchObject({ kind: "auth", message: "exec plugin missing" });
  });

  it("disconnectedState keeps contexts, hidden kinds and toasts; the picker opens only with nothing to pick from", () => {
    const s = {
      ...applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }),
      contexts: [{ name: "prod", cluster: "c", user: "u", namespace: null, sourceFile: "/k" }],
      hiddenKinds: new Set<Kind>(["Secret"]),
      toasts: [{ id: 1, kind: "info" as const, message: "kept" }],
      connection: { ...initialState().connection, state: "connected" as const, context: "prod", busy: true },
    };
    const d = disconnectedState({ ...s, focusRequest: { nodeId: "Pod/p/a", seq: 1 } } as AppState);
    expect(d.focusRequest).toBeNull();
    expect(d.contexts).toBe(s.contexts);
    expect(d.hiddenKinds).toBe(s.hiddenKinds);
    expect(d.toasts).toBe(s.toasts);
    expect(d.pickerOpen).toBe(false); // the Navigator lists the contexts; no modal needed
    expect(d.connection).toEqual(initialState().connection);
    expect(d.nodes.size).toBe(0);
    expect(disconnectedState({ ...s, contexts: [] as AppState["contexts"] } as AppState).pickerOpen).toBe(true);
  });

  it("disconnect failure is toasted and state is reset", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod" }, contexts: [] });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "internal", message: "boom" });
    await useAppStore.getState().disconnect();
    const s = useAppStore.getState();
    expect(s.connection.context).toBeNull();
    expect(s.pickerOpen).toBe(true);
    expect(s.toasts[s.toasts.length - 1]).toMatchObject({ message: "boom" });
  });

  it("reconnect reconnects and re-selects the remembered namespace", async () => {
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", namespace: "payments" },
    });
    await useAppStore.getState().reconnect();
    expect(invoke).toHaveBeenCalledWith("connect", { context: "prod" });
    expect(invoke).toHaveBeenCalledWith("select_namespace", { namespace: "payments", expandedGroups: [] });
  });

  it("reconnect does not re-select the namespace when connect fails", async () => {
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", namespace: "payments" },
    });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "auth", message: "exec plugin missing" });
    await useAppStore.getState().reconnect();
    expect(invoke).toHaveBeenCalledWith("connect", { context: "prod" });
    expect(invoke).not.toHaveBeenCalledWith("select_namespace", expect.anything());
  });

  it("toggleKind hides and shows kinds; setSearch stores the query", () => {
    useAppStore.getState().toggleKind("Secret");
    expect(useAppStore.getState().hiddenKinds.has("Secret")).toBe(true);
    useAppStore.getState().toggleKind("Secret");
    expect(useAppStore.getState().hiddenKinds.has("Secret")).toBe(false);
    useAppStore.getState().setSearch("web");
    expect(useAppStore.getState().search).toBe("web");
  });
});

describe("views", () => {
  it("starts on the graph and switches to a table, fetching rows", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespace: "payments" } });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      cmd === "list_rows" ? { kind: args.kind, columns: [{ key: "name", label: "Name", numeric: false }], rows: [] } : null);
    expect(useAppStore.getState().view).toEqual({ name: "graph" });
    await useAppStore.getState().showTable("Pod");
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Pod" });
    expect(invoke).toHaveBeenCalledWith("list_rows", { kind: "Pod" });
    expect(useAppStore.getState().tables.get("Pod")?.columns[0].key).toBe("name");
    useAppStore.getState().showGraph();
    expect(useAppStore.getState().view).toEqual({ name: "graph" });
  });

  it("showTable opens a denied kind without asking the backend for rows", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespace: "payments" }, deniedKinds: new Set(["Secret"]) });
    await useAppStore.getState().showTable("Secret");
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Secret" });
    expect(invoke).not.toHaveBeenCalledWith("list_rows", expect.anything());
  });

  it("remembers the last table kind so the Table switch can reopen it from Overview", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespace: "payments" } });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      cmd === "list_rows" ? { kind: args.kind, columns: [], rows: [] } : null);
    expect(useAppStore.getState().lastTableKind).toBeNull();
    await useAppStore.getState().showTable("Service");
    useAppStore.getState().showGraph();
    expect(useAppStore.getState().lastTableKind).toBe("Service");
  });

  it("refreshTable keeps the table when the fetch fails and toasts", async () => {
    const existing = { kind: "Pod" as const, columns: [], rows: [] };
    useAppStore.setState({ tables: new Map([["Pod", existing]]) });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "internal", message: "nope" });
    await useAppStore.getState().refreshTable("Pod");
    expect(useAppStore.getState().tables.get("Pod")).toBe(existing);
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("nope");
  });

  it("refreshTable ignores a response that arrives after the namespace has moved on", async () => {
    let resolveListRows!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "list_rows") return new Promise((resolve) => { resolveListRows = resolve; });
      return Promise.resolve(null);
    });
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespace: "a" }, tables: new Map() });
    const refresh = useAppStore.getState().refreshTable("Pod");
    // The namespace changes while the fetch for the old one is still in flight.
    useAppStore.setState((s) => ({ connection: { ...s.connection, namespace: "b" } }));
    resolveListRows({ kind: "Pod", columns: [], rows: [] });
    await refresh;
    expect(useAppStore.getState().tables.has("Pod")).toBe(false);
  });

  it("refreshTable clears a selection whose row disappeared", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      cmd === "list_rows" ? { kind: args.kind, columns: [{ key: "name", label: "Name", numeric: false }], rows: [{ nodeId: "Pod/payments/b", status: "ok", cells: [{ text: "b", status: null }] }] } : null);
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", namespace: "payments" },
      view: { name: "table", kind: "Pod" },
      selectedId: "Pod/payments/a", details: { nodeId: "Pod/payments/a", data: null, events: [], loading: false, editor: viewEditor() },
    });
    await useAppStore.getState().refreshTable("Pod");
    expect(useAppStore.getState().selectedId).toBeNull();
    expect(useAppStore.getState().details).toBeNull();
  });

  it("refreshTable keeps a selection of another kind and one whose row is still there", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      cmd === "list_rows" ? { kind: args.kind, columns: [{ key: "name", label: "Name", numeric: false }], rows: [{ nodeId: "Pod/payments/a", status: "ok", cells: [{ text: "a", status: null }] }] } : null);
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", namespace: "payments" },
      view: { name: "table", kind: "Pod" },
      selectedId: "Pod/payments/a", details: { nodeId: "Pod/payments/a", data: null, events: [], loading: false, editor: viewEditor() },
    });
    await useAppStore.getState().refreshTable("Pod");
    expect(useAppStore.getState().selectedId).toBe("Pod/payments/a");
    // A selection of a different kind (e.g. picked in the graph) is not the table's business.
    useAppStore.setState({ selectedId: "Service/payments/svc", details: { nodeId: "Service/payments/svc", data: null, events: [], loading: false, editor: viewEditor() } });
    await useAppStore.getState().refreshTable("Pod");
    expect(useAppStore.getState().selectedId).toBe("Service/payments/svc");
    // Nor is a table that is not the one on screen.
    useAppStore.setState({ view: { name: "table", kind: "Service" }, selectedId: "Pod/payments/gone", details: { nodeId: "Pod/payments/gone", data: null, events: [], loading: false, editor: viewEditor() } });
    await useAppStore.getState().refreshTable("Pod");
    expect(useAppStore.getState().selectedId).toBe("Pod/payments/gone");
  });

  it("focusInGraph switches to the graph, selects the node and bumps the focus request", async () => {
    useAppStore.setState(applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }));
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      cmd === "list_rows" ? { kind: args.kind, columns: [{ key: "name", label: "Name", numeric: false }], rows: [] } : null);
    await useAppStore.getState().showTable("Pod");
    await useAppStore.getState().focusInGraph("Pod/p/a");
    const s = useAppStore.getState();
    expect(s.view).toEqual({ name: "graph" });
    expect(s.selectedId).toBe("Pod/p/a");
    expect(s.focusRequest).toEqual({ nodeId: "Pod/p/a", seq: 1 });
    await s.focusInGraph("Pod/p/a");
    expect(useAppStore.getState().focusRequest?.seq).toBe(2);
  });

  it("focusInGraph un-hides the node's kind before focusing", async () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [node("Secret/p/db", { kind: "Secret" })], edges: [] }),
      hiddenKinds: new Set(["Secret", "ConfigMap"]), view: { name: "table", kind: "Secret" },
    });
    await useAppStore.getState().focusInGraph("Secret/p/db");
    const s = useAppStore.getState();
    expect([...s.hiddenKinds]).toEqual(["ConfigMap"]);
    expect(s.view).toEqual({ name: "graph" });
    expect(s.focusRequest?.nodeId).toBe("Secret/p/db");
  });

  it("focusInGraph toasts and stays put when the node is not in the graph", async () => {
    useAppStore.setState({ view: { name: "table", kind: "Pod" }, selectedId: null, focusRequest: null });
    await useAppStore.getState().focusInGraph("Pod/p/missing");
    const s = useAppStore.getState();
    expect(s.view).toEqual({ name: "table", kind: "Pod" });
    expect(s.selectedId).toBeNull();
    expect(s.focusRequest).toBeNull();
    expect(s.toasts.at(-1)).toMatchObject({ kind: "info", message: "missing is not on the graph (hidden or collapsed into a group)" });
  });

  it("toggleSidebar flips and persists", async () => {
    const { settings } = await import("../shared/settings");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    await useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(settings.setSidebarCollapsed).toHaveBeenCalledWith(true);
    await useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(settings.setSidebarCollapsed).toHaveBeenCalledWith(false);
  });

  it("selectNamespace clears tables, keeps the view kind and leaves the refetch to the snapshot", async () => {
    // Fetching rows right after select_namespace would race the backend's watchers and could
    // land an empty table (a false "No Pods in payments"); the graph_snapshot handler refetches.
    useAppStore.setState({
      tables: new Map([["Pod", { kind: "Pod", columns: [], rows: [] }]]),
      view: { name: "table", kind: "Pod" },
      connection: { ...initialState().connection, context: "prod" },
    });
    await useAppStore.getState().selectNamespace("payments");
    expect(useAppStore.getState().tables.size).toBe(0);
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Pod" });
    expect(invoke).not.toHaveBeenCalledWith("list_rows", expect.anything());
  });

  it("disconnect clears tables and returns the view to the graph", async () => {
    useAppStore.setState({
      tables: new Map([["Pod", { kind: "Pod", columns: [], rows: [] }]]),
      view: { name: "table", kind: "Pod" },
      connection: { ...initialState().connection, context: "prod" },
    });
    await useAppStore.getState().disconnect();
    expect(useAppStore.getState().tables.size).toBe(0);
    expect(useAppStore.getState().view).toEqual({ name: "graph" });
  });
});

describe("kindStats", () => {
  it("counts nodes per kind with the worst status; PodGroup counts as pods", () => {
    const s = applySnapshot(initialState(), { nodes: [
      node("Pod/p/a"), node("Pod/p/b", { status: "err" }),
      node("PodGroup/p/Deployment/w", { kind: "PodGroup", status: "warn", group: { count: 7, ok: 6, warn: 1, err: 0 } }),
      node("Service/p/s", { kind: "Service" }),
    ], edges: [] });
    const stats = kindStats(s.nodes);
    expect(stats.get("Pod")).toEqual({ count: 9, worst: "err" });
    expect(stats.get("Service")).toEqual({ count: 1, worst: "ok" });
    expect(stats.has("PodGroup")).toBe(false);
  });
});

// ---- editing ----------------------------------------------------------------

const POD_YAML = "kind: Pod\n";
const EDITED_YAML = "kind: Pod\nmetadata:\n  labels:\n    x: y\n";

async function selectPod(): Promise<void> {
  // Earlier suites install their own `invoke` implementations; mockClear keeps them.
  vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "get_object" ? { yaml: POD_YAML, summary: [], related: [] } : null));
  useAppStore.setState({
    ...applySnapshot(initialState(), { nodes: [node("Pod/p/a"), node("Pod/p/b")], edges: [] }),
    connection: { ...initialState().connection, context: "prod", namespace: "p" },
  });
  await useAppStore.getState().select("Pod/p/a");
  vi.mocked(invoke).mockClear();
}

const editor = () => useAppStore.getState().details!.editor;

describe("editor", () => {
  it("details load in view mode with the object's YAML as the original", async () => {
    await selectPod();
    expect(editor()).toEqual({ mode: "view", buffer: "", original: POD_YAML, error: null, saving: false });
  });

  it("startEdit copies the original into the buffer; setBuffer edits it", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    expect(editor()).toMatchObject({ mode: "edit", buffer: POD_YAML, original: POD_YAML, error: null });
    useAppStore.getState().setBuffer(EDITED_YAML);
    expect(editor().buffer).toBe(EDITED_YAML);
    expect(editor().original).toBe(POD_YAML);
  });

  it("startEdit does nothing without loaded details", () => {
    useAppStore.setState({ selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data: null, events: [], loading: true, editor: viewEditor() } });
    useAppStore.getState().startEdit();
    expect(editor().mode).toBe("view");
  });

  it("reviewEdit with no changes toasts and stays in edit mode", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().reviewEdit();
    expect(editor().mode).toBe("edit");
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "No changes" });
  });

  it("reviewEdit with changes enters review; backToEdit returns", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().reviewEdit();
    expect(editor().mode).toBe("review");
    useAppStore.getState().backToEdit();
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML });
  });

  it("applyEdit sends the buffer, adopts the server's version and returns to view mode", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().reviewEdit();
    const saved = { yaml: EDITED_YAML + "status: {}\n", summary: [["Name", "a"]], related: [] };
    vi.mocked(invoke).mockResolvedValueOnce(saved);
    await useAppStore.getState().applyEdit();
    expect(invoke).toHaveBeenCalledWith("update_object", { nodeId: "Pod/p/a", yaml: EDITED_YAML, force: false });
    const s = useAppStore.getState();
    expect(s.details?.data).toEqual(saved);
    expect(s.details?.editor).toEqual({ mode: "view", buffer: "", original: saved.yaml, error: null, saving: false });
    expect(s.toasts.at(-1)).toMatchObject({ kind: "info", message: "Saved Pod a" });
  });

  it("a conflict keeps the edits in edit mode with the error; applyEdit(true) overwrites", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().reviewEdit();
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "conflict", message: "the object has been modified" });
    await useAppStore.getState().applyEdit();
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML, saving: false, error: { kind: "conflict", message: "the object has been modified" } });
    expect(useAppStore.getState().toasts).toHaveLength(0); // the banner in the tab reports it
    vi.mocked(invoke).mockResolvedValueOnce({ yaml: EDITED_YAML, summary: [], related: [] });
    await useAppStore.getState().applyEdit(true);
    expect(invoke).toHaveBeenLastCalledWith("update_object", { nodeId: "Pod/p/a", yaml: EDITED_YAML, force: true });
    expect(editor()).toMatchObject({ mode: "view", original: EDITED_YAML, error: null });
  });

  it("a validation error keeps edit mode with the server message", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().reviewEdit();
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "invalid", message: "spec.replicas: Invalid value: -1" });
    await useAppStore.getState().applyEdit();
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML, error: { kind: "invalid", message: "spec.replicas: Invalid value: -1" } });
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });

  it("a forbidden error is toasted as usual and the editor keeps the edits", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().reviewEdit();
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "forbidden", message: "pods is forbidden" });
    await useAppStore.getState().applyEdit();
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML, error: { kind: "forbidden" } });
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "forbidden", message: "pods is forbidden" });
  });

  it("applyEdit marks saving while the call is in flight", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const apply = useAppStore.getState().applyEdit();
    expect(editor().saving).toBe(true);
    resolve({ yaml: EDITED_YAML, summary: [], related: [] });
    await apply;
    expect(editor().saving).toBe(false);
  });

  it("applyEdit ignores a result that lands after the selection moved on", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const apply = useAppStore.getState().applyEdit();
    useAppStore.setState({ selectedId: "Pod/p/b", details: { nodeId: "Pod/p/b", data: null, events: [], loading: true, editor: viewEditor() } });
    resolve({ yaml: EDITED_YAML, summary: [], related: [] });
    await apply;
    expect(useAppStore.getState().details?.nodeId).toBe("Pod/p/b");
    expect(useAppStore.getState().details?.data).toBeNull();
  });

  it("reloadEdit refetches and replaces both original and buffer, clearing the error", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.setState((s) => ({ details: { ...s.details!, editor: { ...s.details!.editor, error: { kind: "conflict", message: "changed" } } } }));
    const fresh = { yaml: "kind: Pod\nmetadata:\n  annotations:\n    demo: '1'\n", summary: [], related: [] };
    vi.mocked(invoke).mockResolvedValueOnce(fresh);
    await useAppStore.getState().reloadEdit();
    expect(invoke).toHaveBeenCalledWith("get_object", { nodeId: "Pod/p/a" });
    expect(editor()).toEqual({ mode: "edit", buffer: fresh.yaml, original: fresh.yaml, error: null, saving: false });
    expect(useAppStore.getState().details?.data).toEqual(fresh);
  });

  it("reloadEdit failure keeps the edits and reports the error", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "notFound", message: "gone" });
    await useAppStore.getState().reloadEdit();
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML, error: { kind: "notFound", message: "gone" } });
  });

  it("cancelEdit on a clean buffer returns to view mode at once", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().cancelEdit();
    expect(editor()).toMatchObject({ mode: "view", original: POD_YAML });
    expect(useAppStore.getState().discardDialog.open).toBe(false);
  });

  it("cancelEdit on a dirty buffer asks first; confirmDiscard drops the edits, cancelDiscard keeps them", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().cancelEdit();
    expect(useAppStore.getState().discardDialog).toEqual({ open: true, pendingSelect: null, pendingDeselect: false });
    expect(editor().mode).toBe("edit");
    useAppStore.getState().cancelDiscard();
    expect(useAppStore.getState().discardDialog.open).toBe(false);
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML });
    useAppStore.getState().cancelEdit();
    useAppStore.getState().confirmDiscard();
    expect(useAppStore.getState().discardDialog.open).toBe(false);
    expect(editor()).toMatchObject({ mode: "view", original: POD_YAML });
    expect(useAppStore.getState().selectedId).toBe("Pod/p/a");
  });

  it("selecting another node while dirty opens the discard dialog; confirming performs the pending select", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    await useAppStore.getState().select("Pod/p/b");
    expect(useAppStore.getState().selectedId).toBe("Pod/p/a");
    expect(useAppStore.getState().discardDialog).toEqual({ open: true, pendingSelect: "Pod/p/b", pendingDeselect: false });
    expect(invoke).not.toHaveBeenCalledWith("get_object", expect.anything());
    useAppStore.getState().confirmDiscard();
    await vi.waitFor(() => expect(useAppStore.getState().details?.data).not.toBeNull());
    expect(useAppStore.getState().selectedId).toBe("Pod/p/b");
    expect(invoke).toHaveBeenCalledWith("get_object", { nodeId: "Pod/p/b" });
    expect(useAppStore.getState().discardDialog.open).toBe(false);
  });

  it("deselecting while dirty asks too, and confirming clears the selection", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    await useAppStore.getState().select(null);
    expect(useAppStore.getState().selectedId).toBe("Pod/p/a");
    expect(useAppStore.getState().discardDialog).toEqual({ open: true, pendingSelect: null, pendingDeselect: true });
    useAppStore.getState().confirmDiscard();
    await vi.waitFor(() => expect(useAppStore.getState().selectedId).toBeNull());
    expect(useAppStore.getState().details).toBeNull();
  });

  it("selecting another node while editing a clean buffer just switches", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    await useAppStore.getState().select("Pod/p/b");
    expect(useAppStore.getState().selectedId).toBe("Pod/p/b");
    expect(useAppStore.getState().discardDialog.open).toBe(false);
    expect(editor().mode).toBe("view");
  });

  it("object_events never touch the editor", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().setObjectEvents("Pod/p/a", [{ name: "e", type: "Normal", reason: "Pulled", message: "", count: 1, firstTimestamp: null, lastTimestamp: null }]);
    expect(useAppStore.getState().details?.events).toHaveLength(1);
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML });
  });

  it("a delta removing the node under an open editor keeps the editor and flags the deletion", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().applyDelta({ addedNodes: [], updatedNodes: [], removedNodes: ["Pod/p/a"], addedEdges: [], removedEdges: [] });
    const s = useAppStore.getState();
    expect(s.selectedId).toBe("Pod/p/a");
    expect(s.details?.editor).toMatchObject({ mode: "edit", buffer: EDITED_YAML, error: { kind: "notFound", message: "This object was deleted on the server." } });
  });

  it("a snapshot dropping the node under an open editor does the same; in view mode the selection clears", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().applySnapshot({ nodes: [node("Pod/p/b")], edges: [] });
    expect(useAppStore.getState().selectedId).toBe("Pod/p/a");
    expect(editor().error?.kind).toBe("notFound");
    // View mode: the existing behaviour, the selection clears.
    await selectPod();
    useAppStore.getState().applySnapshot({ nodes: [node("Pod/p/b")], edges: [] });
    expect(useAppStore.getState().selectedId).toBeNull();
    expect(useAppStore.getState().details).toBeNull();
  });

  it("a table refresh that loses the edited row keeps the editor and flags the deletion", async () => {
    await selectPod();
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) => (cmd === "list_rows" ? { kind: args.kind, columns: [], rows: [] } : null));
    useAppStore.setState({ view: { name: "table", kind: "Pod" } });
    useAppStore.getState().startEdit();
    await useAppStore.getState().refreshTable("Pod");
    expect(useAppStore.getState().selectedId).toBe("Pod/p/a");
    expect(editor().error?.kind).toBe("notFound");
  });
});

describe("create dialog", () => {
  const withNamespace = () => useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespace: "shop" } });

  it("openCreate defaults to a Deployment template in the current namespace", () => {
    withNamespace();
    useAppStore.getState().openCreate();
    const d = useAppStore.getState().createDialog;
    expect(d).toMatchObject({ open: true, kind: "Deployment", error: null, submitting: false });
    expect(d.buffer).toBe(template("Deployment", "shop"));
    expect(d.buffer).toContain("namespace: shop");
  });

  it("openCreate takes a kind", () => {
    withNamespace();
    useAppStore.getState().openCreate("ConfigMap");
    expect(useAppStore.getState().createDialog.buffer).toBe(template("ConfigMap", "shop"));
  });

  it("setCreateKind re-templates an untouched buffer but keeps an edited one", () => {
    withNamespace();
    useAppStore.getState().openCreate();
    useAppStore.getState().setCreateKind("Service");
    expect(useAppStore.getState().createDialog).toMatchObject({ kind: "Service", buffer: template("Service", "shop") });
    useAppStore.getState().setCreateBuffer("kind: Service\nmetadata:\n  name: mine\n");
    useAppStore.getState().setCreateKind("Secret");
    expect(useAppStore.getState().createDialog).toMatchObject({ kind: "Secret", buffer: "kind: Service\nmetadata:\n  name: mine\n" });
  });

  it("submitCreate sends the buffer, closes, toasts and selects the new object", async () => {
    withNamespace();
    useAppStore.getState().openCreate("ConfigMap");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "create_object") return "ConfigMap/shop/my-configmap";
      if (cmd === "get_object") return { yaml: "kind: ConfigMap\n", summary: [], related: [] };
      return null;
    });
    await useAppStore.getState().submitCreate();
    expect(invoke).toHaveBeenCalledWith("create_object", { namespace: "shop", yaml: template("ConfigMap", "shop") });
    const s = useAppStore.getState();
    expect(s.createDialog.open).toBe(false);
    expect(s.toasts.at(-1)).toMatchObject({ kind: "info", message: "Created ConfigMap my-configmap" });
    expect(s.selectedId).toBe("ConfigMap/shop/my-configmap");
    expect(s.details?.data?.yaml).toBe("kind: ConfigMap\n");
  });

  it("submitCreate tolerates the object not having reached the store yet, and loads it once the watch adds it", async () => {
    withNamespace();
    useAppStore.setState(applySnapshot(useAppStore.getState(), { nodes: [], edges: [] }));
    useAppStore.getState().openCreate("ConfigMap");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "create_object") return "ConfigMap/shop/my-configmap";
      if (cmd === "get_object") throw { kind: "notFound", message: "ConfigMap/shop/my-configmap not found" };
      return null;
    });
    await useAppStore.getState().submitCreate();
    const s = useAppStore.getState();
    expect(s.selectedId).toBe("ConfigMap/shop/my-configmap");
    expect(s.details).toMatchObject({ nodeId: "ConfigMap/shop/my-configmap", data: null, loading: false });
    expect(s.toasts.map((t) => t.kind)).toEqual(["info"]); // only the "Created" toast, no notFound
    // The watch delivers the node: its details are fetched then.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "get_object" ? { yaml: "kind: ConfigMap\n", summary: [], related: [] } : null));
    useAppStore.getState().applyDelta({ addedNodes: [node("ConfigMap/shop/my-configmap", { kind: "ConfigMap", namespace: "shop" })], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });
    await vi.waitFor(() => expect(useAppStore.getState().details?.data?.yaml).toBe("kind: ConfigMap\n"));
  });

  it("submitCreate shows a server error in the dialog and keeps it open", async () => {
    withNamespace();
    useAppStore.getState().openCreate("ConfigMap");
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "conflict", message: "configmaps \"my-configmap\" already exists" });
    await useAppStore.getState().submitCreate();
    const d = useAppStore.getState().createDialog;
    expect(d).toMatchObject({ open: true, submitting: false, error: { kind: "conflict", message: "configmaps \"my-configmap\" already exists" } });
    expect(d.buffer).toBe(template("ConfigMap", "shop"));
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });

  it("closeCreate resets the dialog", () => {
    withNamespace();
    useAppStore.getState().openCreate("Secret");
    useAppStore.getState().setCreateBuffer("x");
    useAppStore.getState().closeCreate();
    expect(useAppStore.getState().createDialog).toEqual(initialState().createDialog);
  });
});

describe("delete dialog", () => {
  it("requestDelete opens for the node; cancelDelete closes without calling the backend", async () => {
    useAppStore.getState().requestDelete("Pod/p/a");
    expect(useAppStore.getState().deleteDialog).toEqual({ open: true, nodeId: "Pod/p/a" });
    useAppStore.getState().cancelDelete();
    expect(useAppStore.getState().deleteDialog).toEqual({ open: false, nodeId: null });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("confirmDelete calls delete_object, closes and toasts", async () => {
    useAppStore.getState().requestDelete("PodGroup/p/Deployment/web");
    await useAppStore.getState().confirmDelete();
    expect(invoke).toHaveBeenCalledWith("delete_object", { nodeId: "PodGroup/p/Deployment/web" });
    expect(useAppStore.getState().deleteDialog.open).toBe(false);
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Deleted Pods web" });
  });

  it("confirmDelete failure is toasted with the error kind", async () => {
    useAppStore.getState().requestDelete("Pod/p/a");
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "forbidden", message: "pods is forbidden" });
    await useAppStore.getState().confirmDelete();
    expect(useAppStore.getState().deleteDialog.open).toBe(false);
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "forbidden", message: "pods is forbidden" });
  });

  it("confirmDelete with nothing requested is a no-op", async () => {
    await useAppStore.getState().confirmDelete();
    expect(invoke).not.toHaveBeenCalled();
  });
});
