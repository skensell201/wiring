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

import { invoke } from "../shared/ipc/tauri";
import { applyDelta, applySnapshot, disconnectedState, initialState, useAppStore, type AppState } from "./store";

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
