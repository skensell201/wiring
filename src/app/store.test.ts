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
import { applyDelta, applySnapshot, disconnectedState, initialState, kindStats, useAppStore, type AppState } from "./store";

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
    s = { ...s, selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data: null, events: [], loading: false } };
    s = applyDelta(s, { addedNodes: [], updatedNodes: [], removedNodes: ["Pod/p/a"], addedEdges: [], removedEdges: [] });
    expect(s.selectedId).toBeNull();
    expect(s.details).toBeNull();
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

  it("disconnectedState keeps contexts, hidden kinds and toasts and opens the picker", () => {
    const s = {
      ...applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }),
      contexts: [{ name: "prod", cluster: "c", user: "u", namespace: null, sourceFile: "/k" }],
      hiddenKinds: new Set<Kind>(["Secret"]),
      toasts: [{ id: 1, kind: "info" as const, message: "kept" }],
      connection: { ...initialState().connection, state: "connected" as const, context: "prod", busy: true },
    };
    const d = disconnectedState(s as AppState);
    expect(d.contexts).toBe(s.contexts);
    expect(d.hiddenKinds).toBe(s.hiddenKinds);
    expect(d.toasts).toBe(s.toasts);
    expect(d.pickerOpen).toBe(true);
    expect(d.connection).toEqual(initialState().connection);
    expect(d.nodes.size).toBe(0);
  });

  it("disconnect failure is toasted and state is reset", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod" } });
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

  it("focusInGraph toasts and stays put when the node is not in the graph", async () => {
    useAppStore.setState({ view: { name: "table", kind: "Pod" }, selectedId: null, focusRequest: null });
    await useAppStore.getState().focusInGraph("Pod/p/missing");
    const s = useAppStore.getState();
    expect(s.view).toEqual({ name: "table", kind: "Pod" });
    expect(s.selectedId).toBeNull();
    expect(s.focusRequest).toBeNull();
    expect(s.toasts.at(-1)).toMatchObject({ kind: "info", message: "missing is not shown in the graph (filtered or collapsed)" });
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

  it("selectNamespace clears tables but keeps the view kind", async () => {
    // list_rows never resolves within this test: selectNamespace fires the refetch without
    // waiting on it, so the assertions below see the state right after the clear.
    vi.mocked(invoke).mockImplementation(
      (cmd: string) => (cmd === "list_rows" ? new Promise(() => {}) : Promise.resolve(null)),
    );
    useAppStore.setState({
      tables: new Map([["Pod", { kind: "Pod", columns: [], rows: [] }]]),
      view: { name: "table", kind: "Pod" },
      connection: { ...initialState().connection, context: "prod" },
    });
    await useAppStore.getState().selectNamespace("payments");
    expect(useAppStore.getState().tables.size).toBe(0);
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Pod" });
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
