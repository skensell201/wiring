import { beforeEach, describe, expect, it, vi } from "vitest";
import graphFixture from "../shared/ipc/fixtures/graph.json";
import type { Graph, GraphDelta, GraphNode, Kind } from "../shared/ipc/types";

const { baseInvoke, POD_YAML } = vi.hoisted(() => {
  const POD_YAML = "kind: Pod\n";
  /** The default backend answers: the mock factory starts with them and `selectPod` reinstalls them. */
  const baseInvoke = async (cmd: string): Promise<unknown> => {
    if (cmd === "get_object") return { yaml: POD_YAML, summary: [["Name", "web-1"]], related: [] };
    if (cmd === "denied_kinds") return ["Secret"];
    if (cmd === "partial_kinds") return ["Pod"];
    if (cmd === "connect") return { context: "prod", serverVersion: "v1.33.0", namespaces: ["default", "payments"] };
    if (cmd === "start_logs") return 42;
    return null;
  };
  return { baseInvoke, POD_YAML };
});

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(baseInvoke),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));
vi.mock("../shared/settings", () => ({
  settings: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    getLastScope: vi.fn(async () => null),
    setLastScope: vi.fn(async () => {}),
    getSidebarCollapsed: vi.fn(async () => false),
    setSidebarCollapsed: vi.fn(async () => {}),
    getDetailsHeight: vi.fn(async () => null),
    setDetailsHeight: vi.fn(async () => {}),
  },
}));

import { invoke } from "../shared/ipc/tauri";
import { settings } from "../shared/settings";
import { template } from "../features/editor/templates";
import { logBuffer } from "../features/logs/logBuffer";
import { initialLogs } from "../features/logs/logsState";
import { applyDelta, applySnapshot, describeNode, disconnectedState, initialState, kindStats, useAppStore, viewEditor, type AppState } from "./store";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: "Pod", namespace: "p", name: id.split("/").pop()!, status: "ok", badges: ["Running"], group: null, ...over,
});

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockClear();
  logBuffer.clear();
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
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", scope: ["b"] } });
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
    useAppStore.setState((s) => ({ connection: { ...s.connection, scope: ["b"] } }));
    await first;
    expect(useAppStore.getState().deniedKinds.size).toBe(0);
  });

  it("selectNamespace clears the graph, resets readiness and asks the backend", async () => {
    useAppStore.setState({ ...applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }), connection: { ...initialState().connection, context: "prod" } });
    await useAppStore.getState().selectNamespace("payments");
    const s = useAppStore.getState();
    expect(s.nodes.size).toBe(0);
    expect(s.graphReady).toBe(false);
    expect(s.connection.scope).toEqual(["payments"]);
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: ["payments"], expandedGroups: [] });
    expect([...s.deniedKinds]).toEqual(["Secret"]);
    expect([...s.partialKinds]).toEqual(["Pod"]);
    expect(s.deniedLoaded).toBe(true);
  });

  it("selectNamespace marks the denied kinds unknown until the backend answers", async () => {
    useAppStore.setState({ deniedLoaded: true, connection: { ...initialState().connection, context: "prod" } });
    const pending = useAppStore.getState().selectNamespace("payments");
    expect(useAppStore.getState().deniedLoaded).toBe(false);
    await pending;
    expect(useAppStore.getState().deniedLoaded).toBe(true);
  });

  it("selectNamespace stops waiting for denied kinds when asking for them fails", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod" } });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => { if (cmd === "denied_kinds") throw { kind: "network", message: "down" }; return null; });
    await useAppStore.getState().selectNamespace("payments");
    vi.mocked(invoke).mockImplementation(baseInvoke);
    expect(useAppStore.getState().deniedLoaded).toBe(true);
  });

  it("selectScope watches several namespaces and remembers them", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: ["a", "b"] } });
    await useAppStore.getState().selectScope(["a", "b"]);
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: ["a", "b"], expandedGroups: [] });
    expect(useAppStore.getState().connection.scope).toEqual(["a", "b"]);
    expect(settings.setLastScope).toHaveBeenCalledWith("prod", ["a", "b"]);
  });

  it("a failed selectScope is not remembered: the previous scope and graph come back and the error shows", async () => {
    vi.mocked(settings.setLastScope).mockClear();
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }),
      connection: { ...initialState().connection, context: "prod", namespaces: ["p"], canListNamespaces: false, scope: ["p"] },
    });
    vi.mocked(invoke).mockImplementationOnce(async () => { throw { kind: "invalid", message: "all namespaces needs permission to list namespaces; pick namespaces by name" }; });
    await useAppStore.getState().selectScope("all");
    const s = useAppStore.getState();
    expect(s.connection.scope).toEqual(["p"]);
    expect(s.graphReady).toBe(true);
    expect(s.nodes.has("Pod/p/a")).toBe(true);
    expect(s.toasts.at(-1)).toMatchObject({ kind: "invalid", message: expect.stringContaining("all namespaces needs permission") });
    expect(settings.setLastScope).not.toHaveBeenCalled();
  });

  it("a refused switch refetches the restored scope's denied kinds if they were never loaded", async () => {
    // A → B quickly drops A's RBAC answer; B is then refused and A comes back without it.
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [], edges: [] }), deniedLoaded: false,
      connection: { ...initialState().connection, context: "prod", namespaces: ["a", "b"], scope: ["a"] },
    });
    vi.mocked(invoke).mockImplementationOnce(async () => { throw { kind: "forbidden", message: "no" }; });
    await useAppStore.getState().selectScope(["b"]);
    const s = useAppStore.getState();
    expect(s.connection.scope).toEqual(["a"]);
    expect(s.deniedLoaded).toBe(true);
    expect([...s.deniedKinds]).toEqual(["Secret"]);
    expect([...s.partialKinds]).toEqual(["Pod"]);
  });

  it("a refused switch keeps already-loaded denied kinds without asking again", async () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [], edges: [] }), deniedLoaded: true, deniedKinds: new Set(["ConfigMap"]),
      connection: { ...initialState().connection, context: "prod", namespaces: ["a", "b"], scope: ["a"] },
    });
    vi.mocked(invoke).mockImplementationOnce(async () => { throw { kind: "forbidden", message: "no" }; });
    await useAppStore.getState().selectScope(["b"]);
    expect(vi.mocked(invoke).mock.calls.map(([cmd]) => cmd)).not.toContain("denied_kinds");
    expect([...useAppStore.getState().deniedKinds]).toEqual(["ConfigMap"]);
  });

  it("selectScope('all') sends null", async () => {
    await useAppStore.getState().selectScope("all");
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: null, expandedGroups: [] });
  });

  it("a snapshot with nodes outside the scope is ignored", () => {
    useAppStore.setState({ connection: { ...initialState().connection, scope: ["a", "b"] } });
    useAppStore.getState().applySnapshot({ nodes: [node("Pod/c/x", { namespace: "c" })], edges: [] });
    expect(useAppStore.getState().graphReady).toBe(false);
    useAppStore.getState().applySnapshot({ nodes: [node("Pod/a/x", { namespace: "a" }), node("Pod/b/y", { namespace: "b" })], edges: [] });
    expect(useAppStore.getState().nodes.size).toBe(2);
  });

  it("a too-large snapshot keeps the counts and switches to a table", () => {
    useAppStore.setState({ connection: { ...initialState().connection, scope: "all" }, view: { name: "graph" }, lastTableKind: null });
    useAppStore.getState().applySnapshot({ nodes: [], edges: [], tooLarge: { nodes: 1873, kinds: [{ kind: "Pod", count: 1500, worst: "err" }] } });
    const s = useAppStore.getState();
    expect(s.tooLarge?.nodes).toBe(1873);
    expect(s.view).toEqual({ name: "table", kind: "Deployment" });
  });

  it("a normal snapshot clears tooLarge", () => {
    useAppStore.setState({ connection: { ...initialState().connection, scope: ["p"] }, tooLarge: { nodes: 2000, kinds: [] } });
    useAppStore.getState().applySnapshot({ nodes: [node("Pod/p/a")], edges: [] });
    expect(useAppStore.getState().tooLarge).toBeNull();
  });

  it("Create defaults to the first namespace of the scope and creates there", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, scope: ["b", "a"], namespaces: ["a", "b"] } });
    useAppStore.getState().openCreate();
    expect(useAppStore.getState().createDialog.namespace).toBe("b");
    useAppStore.getState().setCreateNamespace("a");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "create_object" ? "Deployment/a/my-deployment" : cmd === "get_object" ? { yaml: "", summary: [], related: [] } : null));
    expect(useAppStore.getState().createDialog.buffer).toBe(template("Deployment", "a"));
    await useAppStore.getState().submitCreate();
    expect(invoke).toHaveBeenCalledWith("create_object", { namespace: "a", yaml: template("Deployment", "a") });
    vi.mocked(invoke).mockImplementation(baseInvoke);
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

  it("connect failure is kept as the last error and leaves the app disconnected, without a toast", async () => {
    // The backend tears the previous session down before dialling the new context, so a failed
    // connect from a connected state must not pretend the old connection is still alive.
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }),
      connection: { ...initialState().connection, state: "connected", context: "staging", scope: ["payments"] },
      toasts: [{ id: 1, kind: "info", message: "earlier" }],
    });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "auth", message: "exec plugin missing" });
    expect(await useAppStore.getState().connect("prod")).toBe(false);
    const s = useAppStore.getState();
    expect(s.connection).toEqual({ ...initialState().connection, lastError: { context: "prod", error: { kind: "auth", message: "exec plugin missing" } } });
    expect(s.nodes.size).toBe(0);
    expect(s.toasts).toEqual([{ id: 1, kind: "info", message: "earlier" }]);
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
      connection: { ...initialState().connection, context: "prod", scope: ["payments"] },
    });
    await useAppStore.getState().reconnect();
    expect(invoke).toHaveBeenCalledWith("connect", { context: "prod" });
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: ["payments"], expandedGroups: [] });
  });

  it("reconnect does not re-select the namespace when connect fails", async () => {
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", scope: ["payments"] },
    });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "auth", message: "exec plugin missing" });
    await useAppStore.getState().reconnect();
    expect(invoke).toHaveBeenCalledWith("connect", { context: "prod" });
    expect(invoke).not.toHaveBeenCalledWith("select_namespaces", expect.anything());
  });

  it("starts with the RBAC and Node chips off, and toggling Node shows it", () => {
    expect([...initialState().hiddenKinds].sort()).toEqual(["ClusterRole", "ClusterRoleBinding", "Node", "Role", "RoleBinding"]);
    expect(initialState().hiddenKinds.has("NetworkPolicy")).toBe(false);
    useAppStore.getState().toggleKind("Node");
    expect(useAppStore.getState().hiddenKinds.has("Node")).toBe(false);
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
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", scope: ["payments"] } });
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      cmd === "list_rows" ? { kind: args.kind, columns: [{ key: "name", label: "Name", numeric: false }], rows: [] } : null);
    expect(useAppStore.getState().view).toEqual({ name: "graph" });
    await useAppStore.getState().showTable("Pod");
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Pod" });
    expect(invoke).toHaveBeenCalledWith("list_rows", { kind: "Pod", includeHelmStorage: false });
    expect(useAppStore.getState().tables.get("Pod")?.columns[0].key).toBe("name");
    useAppStore.getState().showGraph();
    expect(useAppStore.getState().view).toEqual({ name: "graph" });
  });

  it("showTable opens a denied kind without asking the backend for rows", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", scope: ["payments"] }, deniedKinds: new Set(["Secret"]) });
    await useAppStore.getState().showTable("Secret");
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Secret" });
    expect(invoke).not.toHaveBeenCalledWith("list_rows", expect.anything());
  });

  it("remembers the last table kind so the Table switch can reopen it from Overview", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", scope: ["payments"] } });
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
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", scope: ["a"] }, tables: new Map() });
    const refresh = useAppStore.getState().refreshTable("Pod");
    // The namespace changes while the fetch for the old one is still in flight.
    useAppStore.setState((s) => ({ connection: { ...s.connection, scope: ["b"] } }));
    resolveListRows({ kind: "Pod", columns: [], rows: [] });
    await refresh;
    expect(useAppStore.getState().tables.has("Pod")).toBe(false);
  });

  it("refreshTable clears a selection whose row disappeared", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      cmd === "list_rows" ? { kind: args.kind, columns: [{ key: "name", label: "Name", numeric: false }], rows: [{ nodeId: "Pod/payments/b", status: "ok", cells: [{ text: "b", status: null }] }] } : null);
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", scope: ["payments"] },
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
      connection: { ...initialState().connection, context: "prod", scope: ["payments"] },
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

  it("focusInGraph says to use the table while the graph is too large", async () => {
    useAppStore.setState({ view: { name: "table", kind: "Pod" }, tooLarge: { nodes: 2000, kinds: [] }, focusRequest: null });
    await useAppStore.getState().focusInGraph("Pod/p/a");
    const s = useAppStore.getState();
    expect(s.view).toEqual({ name: "table", kind: "Pod" });
    expect(s.focusRequest).toBeNull();
    expect(s.toasts.at(-1)).toMatchObject({ kind: "info", message: "The graph is too large to show \u2014 use the table" });
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

const EDITED_YAML = "kind: Pod\nmetadata:\n  labels:\n    x: y\n";

async function selectPod(): Promise<void> {
  // Earlier suites install their own `invoke` implementations; mockClear keeps them.
  vi.mocked(invoke).mockImplementation(baseInvoke);
  useAppStore.setState({
    ...applySnapshot(initialState(), { nodes: [node("Pod/p/a"), node("Pod/p/b")], edges: [] }),
    connection: { ...initialState().connection, context: "prod", scope: ["p"] },
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
    expect(useAppStore.getState().discardDialog).toEqual({ open: true, pendingSelect: null, pendingDeselect: false, pendingScope: null });
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
    expect(useAppStore.getState().discardDialog).toEqual({ open: true, pendingSelect: "Pod/p/b", pendingDeselect: false, pendingScope: null });
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
    expect(useAppStore.getState().discardDialog).toEqual({ open: true, pendingSelect: null, pendingDeselect: true, pendingScope: null });
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

  it("entering tooLarge is not a deletion: the details and an open editor stay", async () => {
    const tooLarge = { nodes: 1873, kinds: [{ kind: "Pod" as const, count: 1873, worst: "ok" as const }] };
    await selectPod();
    useAppStore.getState().applySnapshot({ nodes: [], edges: [], tooLarge });
    let s = useAppStore.getState();
    expect(s.selectedId).toBe("Pod/p/a");
    expect(s.details?.data?.yaml).toBe(POD_YAML);
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().applySnapshot({ nodes: [], edges: [], tooLarge });
    s = useAppStore.getState();
    expect(s.selectedId).toBe("Pod/p/a");
    expect(s.details?.editor).toMatchObject({ mode: "edit", buffer: EDITED_YAML, error: null });
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

  it("setBuffer in view mode is a no-op", async () => {
    await selectPod();
    useAppStore.getState().setBuffer(EDITED_YAML);
    expect(editor()).toEqual(viewEditor(POD_YAML));
  });

  it("applyEdit while saving is a no-op", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const first = useAppStore.getState().applyEdit();
    await useAppStore.getState().applyEdit(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve({ yaml: EDITED_YAML, summary: [], related: [] });
    await first;
    expect(editor().mode).toBe("view");
  });

  it("backToEdit and cancelEdit are no-ops while a save is in flight", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().reviewEdit();
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const apply = useAppStore.getState().applyEdit();
    useAppStore.getState().backToEdit();
    expect(editor().mode).toBe("review");
    useAppStore.getState().cancelEdit();
    expect(editor().mode).toBe("review");
    expect(useAppStore.getState().discardDialog.open).toBe(false);
    resolve({ yaml: EDITED_YAML, summary: [], related: [] });
    await apply;
    expect(editor().mode).toBe("view");
  });

  it("stale failure of applyEdit after the selection moved is dropped", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    let reject!: (e: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const apply = useAppStore.getState().applyEdit();
    // Moving on while the write is in flight asks; confirming ends the session.
    await useAppStore.getState().select("Pod/p/b");
    useAppStore.getState().confirmDiscard();
    await vi.waitFor(() => expect(useAppStore.getState().details?.data).not.toBeNull());
    expect(useAppStore.getState().selectedId).toBe("Pod/p/b");
    reject({ kind: "conflict", message: "the object has been modified" });
    await apply;
    expect(useAppStore.getState().details?.nodeId).toBe("Pod/p/b");
    expect(editor()).toEqual(viewEditor(POD_YAML));
  });

  it("failed apply after the editor was discarded does not reopen it", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    let reject!: (e: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    const apply = useAppStore.getState().applyEdit();
    // Deleting the object while its write is in flight closes the editor (see the delete suite).
    useAppStore.getState().requestDelete("Pod/p/a");
    await useAppStore.getState().confirmDelete();
    expect(editor()).toEqual(viewEditor(POD_YAML));
    reject({ kind: "notFound", message: "pods \"a\" not found" });
    await apply;
    expect(useAppStore.getState().details?.nodeId).toBe("Pod/p/a");
    expect(editor()).toEqual(viewEditor(POD_YAML));
  });

  it("successful apply after a new edit session on the same node does not clobber it", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const apply = useAppStore.getState().applyEdit();
    // Away (discarding the session) and back while the write is in flight, then a fresh edit.
    await useAppStore.getState().select("Pod/p/b");
    useAppStore.getState().confirmDiscard();
    await vi.waitFor(() => expect(useAppStore.getState().details).toMatchObject({ nodeId: "Pod/p/b", loading: false }));
    await useAppStore.getState().select("Pod/p/a");
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer("kind: Pod\nz: 1\n");
    resolve({ yaml: EDITED_YAML, summary: [], related: [] });
    await apply;
    expect(editor()).toMatchObject({ mode: "edit", buffer: "kind: Pod\nz: 1\n", original: POD_YAML, saving: false });
    expect(useAppStore.getState().details?.data?.yaml).toBe(POD_YAML);
  });

  it("reload resolving after cancel is dropped", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const reload = useAppStore.getState().reloadEdit();
    useAppStore.getState().cancelEdit(); // clean buffer: straight back to view
    expect(editor().mode).toBe("view");
    resolve({ yaml: "kind: Pod\nfresh: 1\n", summary: [], related: [] });
    await reload;
    expect(editor()).toEqual(viewEditor(POD_YAML));
    expect(useAppStore.getState().details?.data?.yaml).toBe(POD_YAML);
  });

  it("selectNamespace while dirty asks first; cancelDiscard keeps everything, confirmDiscard switches", async () => {
    await selectPod();
    const { settings } = await import("../shared/settings");
    vi.mocked(settings.setLastScope).mockClear();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    await useAppStore.getState().selectNamespace("q");
    expect(useAppStore.getState().discardDialog).toEqual({ open: true, pendingSelect: null, pendingDeselect: false, pendingScope: ["q"] });
    expect(useAppStore.getState().connection.scope).toEqual(["p"]);
    expect(useAppStore.getState().nodes.size).toBe(2);
    expect(invoke).not.toHaveBeenCalledWith("select_namespaces", expect.anything());
    // A switch the user may still cancel must not become the remembered namespace.
    expect(settings.setLastScope).not.toHaveBeenCalled();
    useAppStore.getState().cancelDiscard();
    expect(useAppStore.getState().discardDialog.open).toBe(false);
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML });
    expect(useAppStore.getState().connection.scope).toEqual(["p"]);
    await useAppStore.getState().selectNamespace("q");
    useAppStore.getState().confirmDiscard();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: ["q"], expandedGroups: [] }));
    const s = useAppStore.getState();
    expect(s.connection.scope).toEqual(["q"]);
    expect(s.details).toBeNull();
    expect(s.discardDialog.open).toBe(false);
    // Remembered once select_namespaces has succeeded.
    await vi.waitFor(() => expect(settings.setLastScope).toHaveBeenCalledWith("prod", ["q"]));
  });

  it("disconnectedState toasts the edits it discards", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    const d = disconnectedState(useAppStore.getState());
    expect(d.details).toBeNull();
    expect(d.toasts).toHaveLength(1);
    expect(d.toasts[0]).toMatchObject({ kind: "info", message: "Unsaved edits to Pod a were discarded" });
    useAppStore.getState().setBuffer(POD_YAML); // clean again: nothing to report
    expect(disconnectedState(useAppStore.getState()).toasts).toHaveLength(0);
  });

  it("connect toasts the edits it discards", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "connect" ? { context: "prod", serverVersion: "v1.33.0", namespaces: [] } : null));
    await useAppStore.getState().connect("prod");
    expect(useAppStore.getState().details).toBeNull();
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Unsaved edits to Pod a were discarded" });
  });
});

describe("create dialog", () => {
  const withNamespace = () => useAppStore.setState({ connection: { ...initialState().connection, context: "prod", scope: ["shop"] } });

  it("openCreate defaults to a Deployment template in the current namespace", () => {
    withNamespace();
    useAppStore.getState().openCreate();
    const d = useAppStore.getState().createDialog;
    expect(d).toMatchObject({ open: true, kind: "Deployment", error: null, submitting: false });
    expect(d.buffer).toBe(template("Deployment", "shop"));
    expect(d.buffer).toContain("namespace: shop");
  });

  it("openCreate defaults to the kind of the open table", () => {
    withNamespace();
    useAppStore.setState({ view: { name: "table", kind: "ConfigMap" } });
    useAppStore.getState().openCreate();
    expect(useAppStore.getState().createDialog).toMatchObject({ kind: "ConfigMap", buffer: template("ConfigMap", "shop") });
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

  it("submitCreate while another object is dirty asks before switching", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().openCreate("ConfigMap");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "create_object") return "ConfigMap/p/my-configmap";
      if (cmd === "get_object") throw { kind: "notFound", message: "ConfigMap/p/my-configmap not found" };
      return null;
    });
    await useAppStore.getState().submitCreate();
    const s = useAppStore.getState();
    expect(s.createDialog.open).toBe(false);
    expect(s.toasts.map((t) => t.message)).toEqual(["Created ConfigMap my-configmap"]);
    expect(s.selectedId).toBe("Pod/p/a");
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML });
    expect(s.discardDialog).toEqual({ open: true, pendingSelect: "ConfigMap/p/my-configmap", pendingDeselect: false, pendingScope: null });
    expect(invoke).not.toHaveBeenCalledWith("get_object", expect.anything());
    useAppStore.getState().confirmDiscard();
    await vi.waitFor(() => expect(useAppStore.getState().details).toMatchObject({ nodeId: "ConfigMap/p/my-configmap", data: null, loading: false }));
    // The object has not reached the graph yet: get_object's notFound is expected, not toasted.
    expect(useAppStore.getState().toasts.map((t) => t.kind)).toEqual(["info"]);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "get_object" ? { yaml: "kind: ConfigMap\n", summary: [], related: [] } : null));
    useAppStore.getState().applyDelta({ addedNodes: [node("ConfigMap/p/my-configmap", { kind: "ConfigMap" })], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });
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
    useAppStore.getState().requestDelete("Pod/p/a");
    await useAppStore.getState().confirmDelete();
    expect(invoke).toHaveBeenCalledWith("delete_object", { nodeId: "Pod/p/a" });
    expect(useAppStore.getState().deleteDialog.open).toBe(false);
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Deleted Pod a" });
  });

  it("confirmDelete on a PodGroup toasts the number of pods deleted", async () => {
    const group = node("PodGroup/p/Deployment/web", { kind: "PodGroup", group: { count: 7, ok: 7, warn: 0, err: 0 } });
    useAppStore.setState({ nodes: new Map([[group.id, group]]) });
    useAppStore.getState().requestDelete("PodGroup/p/Deployment/web");
    await useAppStore.getState().confirmDelete();
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Deleted 7 pods of Deployment web" });
  });

  it("confirmDelete failure is toasted with the error kind", async () => {
    useAppStore.getState().requestDelete("Pod/p/a");
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "forbidden", message: "pods is forbidden" });
    await useAppStore.getState().confirmDelete();
    expect(useAppStore.getState().deleteDialog.open).toBe(false);
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "forbidden", message: "pods is forbidden" });
  });

  it("confirmDelete of the object under an open editor closes the editor; a failed delete leaves it alone", async () => {
    await selectPod();
    useAppStore.getState().startEdit();
    useAppStore.getState().setBuffer(EDITED_YAML);
    useAppStore.getState().requestDelete("Pod/p/a");
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "forbidden", message: "pods is forbidden" });
    await useAppStore.getState().confirmDelete();
    expect(editor()).toMatchObject({ mode: "edit", buffer: EDITED_YAML });
    useAppStore.getState().requestDelete("Pod/p/a");
    await useAppStore.getState().confirmDelete();
    expect(editor()).toEqual(viewEditor(POD_YAML));
    expect(useAppStore.getState().selectedId).toBe("Pod/p/a");
    // In view mode the watch's removal clears the selection as usual.
    useAppStore.getState().applyDelta({ addedNodes: [], updatedNodes: [], removedNodes: ["Pod/p/a"], addedEdges: [], removedEdges: [] });
    expect(useAppStore.getState().selectedId).toBeNull();
  });

  it("confirmDelete with nothing requested is a no-op", async () => {
    await useAppStore.getState().confirmDelete();
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ---- logs ------------------------------------------------------------------

/** The channel handed to the last start_logs call, so tests can push messages through it. */
function lastLogChannel(): { onmessage: (m: unknown) => void } {
  const call = [...vi.mocked(invoke).mock.calls].reverse().find((c) => c[0] === "start_logs");
  if (!call) throw new Error("start_logs was not called");
  return (call[1] as { onMessage: { onmessage: (m: unknown) => void } }).onMessage;
}

describe("logs", () => {
  it("startLogs opens a session with the current options and routes lines to the buffer", async () => {
    await selectPod();
    await useAppStore.getState().startLogs("Pod/p/a");
    expect(invoke).toHaveBeenCalledWith("start_logs", expect.objectContaining({ nodeId: "Pod/p/a", container: null, previous: false, timestamps: false }));
    expect(useAppStore.getState().logs).toMatchObject({ sessionId: 42, nodeId: "Pod/p/a", status: "starting" });
    lastLogChannel().onmessage({ type: "started", sessionId: 42, pod: "a", container: "c" });
    lastLogChannel().onmessage({ type: "lines", sessionId: 42, lines: [{ pod: "a", container: "c", text: "hi" }] });
    expect(useAppStore.getState().logs.status).toBe("streaming");
    expect(logBuffer.lines().map((l) => l.text)).toEqual(["hi"]);
  });

  it("stopLogs stops the backend session, resets state and clears the buffer", async () => {
    await selectPod();
    await useAppStore.getState().startLogs("Pod/p/a");
    lastLogChannel().onmessage({ type: "lines", sessionId: 42, lines: [{ pod: "a", container: "c", text: "hi" }] });
    await useAppStore.getState().stopLogs();
    expect(invoke).toHaveBeenCalledWith("stop_logs", { sessionId: 42 });
    expect(useAppStore.getState().logs.status).toBe("idle");
    expect(logBuffer.lines()).toEqual([]);
  });

  it("messages still queued from a stopped session are ignored", async () => {
    await selectPod();
    await useAppStore.getState().startLogs("Pod/p/a");
    const old = lastLogChannel();
    await useAppStore.getState().stopLogs();
    // Batches the webview had already queued from the stopped channel arrive after the stop.
    old.onmessage({ type: "started", sessionId: 42, pod: "a", container: "c" });
    old.onmessage({ type: "lines", sessionId: 42, lines: [{ pod: "a", container: "c", text: "late" }] });
    expect(useAppStore.getState().logs.status).toBe("idle");
    expect(logBuffer.lines()).toEqual([]);
  });

  it("a superseded start that resolves late stops its session and keeps the newer id", async () => {
    await selectPod();
    let resolveA: (id: number) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "start_logs") return baseInvoke(cmd);
      return (args as { nodeId: string }).nodeId === "Pod/p/a" ? new Promise<number>((r) => { resolveA = r; }) : 43;
    });
    const a = useAppStore.getState().startLogs("Pod/p/a");
    // A reconnect meanwhile: the slice is rebuilt and the backend's session ids restart, so the
    // generation must not restart with them.
    useAppStore.setState(disconnectedState(useAppStore.getState()));
    await useAppStore.getState().startLogs("Pod/p/b");
    expect(useAppStore.getState().logs).toMatchObject({ sessionId: 43, nodeId: "Pod/p/b" });
    resolveA(42);
    await a;
    expect(invoke).toHaveBeenCalledWith("stop_logs", { sessionId: 42 });
    expect(useAppStore.getState().logs).toMatchObject({ sessionId: 43, nodeId: "Pod/p/b" });
  });

  it("a superseded start that fails late is not toasted", async () => {
    await selectPod();
    let rejectA: (e: unknown) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "start_logs") return baseInvoke(cmd);
      return (args as { nodeId: string }).nodeId === "Pod/p/a" ? new Promise<number>((_, rej) => { rejectA = rej; }) : 43;
    });
    const a = useAppStore.getState().startLogs("Pod/p/a");
    await useAppStore.getState().startLogs("Pod/p/b");
    rejectA({ kind: "internal", message: "gone" });
    await a;
    expect(useAppStore.getState().toasts).toEqual([]);
    expect(useAppStore.getState().logs).toMatchObject({ sessionId: 43, nodeId: "Pod/p/b", status: "starting" });
  });

  it("messages from a superseded session are ignored", async () => {
    await selectPod();
    await useAppStore.getState().startLogs("Pod/p/a");
    const old = lastLogChannel();
    await useAppStore.getState().startLogs("Pod/p/b");
    old.onmessage({ type: "lines", sessionId: 42, lines: [{ pod: "a", container: "c", text: "stale" }] });
    old.onmessage({ type: "started", sessionId: 42, pod: "a", container: "c" });
    expect(logBuffer.lines()).toEqual([]);
    expect(useAppStore.getState().logs.status).toBe("starting");
  });

  it("changing container, previous or timestamps restarts the session with the new options", async () => {
    await selectPod();
    await useAppStore.getState().startLogs("Pod/p/a");
    await useAppStore.getState().setLogsContainer("sidecar");
    expect(invoke).toHaveBeenLastCalledWith("start_logs", expect.objectContaining({ container: "sidecar" }));
    await useAppStore.getState().toggleLogsPrevious();
    expect(invoke).toHaveBeenLastCalledWith("start_logs", expect.objectContaining({ container: "sidecar", previous: true }));
    await useAppStore.getState().toggleLogsTimestamps();
    expect(invoke).toHaveBeenLastCalledWith("start_logs", expect.objectContaining({ previous: true, timestamps: true }));
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "stop_logs")).toHaveLength(3);
  });

  it("a start_logs failure is toasted and leaves the state idle", async () => {
    await selectPod();
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "invalid", message: "ConfigMap has no logs" });
    await useAppStore.getState().startLogs("ConfigMap/p/x");
    expect(useAppStore.getState().logs.status).toBe("idle");
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "invalid" });
  });

  it("selecting another node, switching namespace and disconnecting stop the logs", async () => {
    await selectPod();
    await useAppStore.getState().startLogs("Pod/p/a");
    await useAppStore.getState().select("Pod/p/b");
    expect(useAppStore.getState().logs.status).toBe("idle");
    await useAppStore.getState().startLogs("Pod/p/b");
    await useAppStore.getState().selectNamespace("q");
    expect(useAppStore.getState().logs.status).toBe("idle");
    useAppStore.setState({ ...disconnectedState({ ...useAppStore.getState(), logs: { ...initialLogs(), status: "streaming" } }) });
    expect(useAppStore.getState().logs.status).toBe("idle");
  });

  it("toggleDetailsMaximized flips the flag; deselecting and switching namespace reset it", async () => {
    await selectPod();
    useAppStore.getState().toggleDetailsMaximized();
    expect(useAppStore.getState().detailsMaximized).toBe(true);
    await useAppStore.getState().select("Pod/p/b"); // another node keeps the panel as it is
    expect(useAppStore.getState().detailsMaximized).toBe(true);
    await useAppStore.getState().select(null);
    expect(useAppStore.getState().detailsMaximized).toBe(false);
    useAppStore.getState().toggleDetailsMaximized();
    await useAppStore.getState().selectNamespace("q");
    expect(useAppStore.getState().detailsMaximized).toBe(false);
  });

  it("the selected object deleted on the server restores the maximised panel", () => {
    let s = applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] });
    s = { ...s, selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data: null, events: [], loading: false, editor: viewEditor() }, detailsMaximized: true };
    s = applyDelta(s, { addedNodes: [], updatedNodes: [], removedNodes: ["Pod/p/a"], addedEdges: [], removedEdges: [] });
    expect(s.selectedId).toBeNull();
    expect(s.detailsMaximized).toBe(false);
  });
});

describe("describeNode", () => {
  it("names a built-in kind and a custom resource's own kind", () => {
    expect(describeNode("Pod/shop/web-1")).toBe("Pod web-1");
    expect(describeNode("Custom/cert-manager.io/v1/Certificate/shop/web-tls")).toBe("Certificate web-tls");
  });
});
