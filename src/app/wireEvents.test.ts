import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandlers } from "../shared/ipc/events";
import { initialState, useAppStore, viewEditor } from "./store";

// vi.mock is hoisted above imports, so shared state must be hoisted too.
const hoisted = vi.hoisted(() => ({ handlers: null as EventHandlers | null }));
vi.mock("../shared/ipc/events", () => ({
  listenAll: vi.fn(async (h: EventHandlers) => { hoisted.handlers = h; return () => { hoisted.handlers = null; }; }),
}));
vi.mock("../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

import type { GraphDelta } from "../shared/ipc/types";
import { invoke } from "../shared/ipc/tauri";
import { cancelDetailsRefresh } from "./store";
import { TABLE_REFRESH_DEBOUNCE_MS } from "./tableRefresh";
import { deltaTouches, wireEvents } from "./wireEvents";

const node = { id: "Pod/p/a", kind: "Pod" as const, namespace: "p", name: "a", status: "ok" as const, badges: [], group: null };
const podGroupNode = { ...node, id: "PodGroup/p/Deployment/w", kind: "PodGroup" as const };
const emptyDelta: GraphDelta = { addedNodes: [], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] };

beforeEach(() => { useAppStore.setState(initialState()); hoisted.handlers = null; });

describe("wireEvents", () => {
  it("routes snapshot, delta, connection state, object events and errors into the store", async () => {
    const stop = await wireEvents();
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["p"] } });
    hoisted.handlers!.graph_snapshot({ nodes: [node], edges: [] });
    expect(useAppStore.getState().nodes.size).toBe(1);
    hoisted.handlers!.graph_delta({ addedNodes: [{ ...node, id: "Pod/p/b", name: "b" }], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });
    expect(useAppStore.getState().nodes.size).toBe(2);
    hoisted.handlers!.connection_state("degraded");
    expect(useAppStore.getState().connection.state).toBe("degraded");
    useAppStore.setState({ selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data: null, events: [], loading: false, editor: viewEditor() } });
    hoisted.handlers!.object_events({ nodeId: "Pod/p/a", events: [{ name: "e", type: "Normal", reason: "Scheduled", message: "ok", count: 1, firstTimestamp: null, lastTimestamp: null }] });
    expect(useAppStore.getState().details?.events).toHaveLength(1);
    hoisted.handlers!.object_events({ nodeId: "Pod/p/zzz", events: [] });
    expect(useAppStore.getState().details?.events).toHaveLength(1); // ignored: not the selection
    const fwd = { id: 1, nodeId: "Service/p/web", targetLabel: "Service web", remotePort: 80, localPort: 8080, pod: null, status: "noReadyPod" as const, message: null };
    hoisted.handlers!.forwards_changed([fwd]);
    expect(useAppStore.getState().forwards).toEqual([fwd]);
    hoisted.handlers!.connection_error({ kind: "forbidden", message: "Secret: forbidden" });
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "forbidden" });
    stop();
    expect(hoisted.handlers).toBeNull();
  });

  it("a disconnected state reopens the context picker and clears the graph", async () => {
    await wireEvents();
    useAppStore.setState({ ...useAppStore.getState(), connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["p"] } });
    hoisted.handlers!.graph_snapshot({ nodes: [node], edges: [] });
    expect(useAppStore.getState().nodes.size).toBe(1);
    hoisted.handlers!.connection_state("disconnected");
    const s = useAppStore.getState();
    expect(s.connection.state).toBe("disconnected");
    expect(s.nodes.size).toBe(0);
  });

  it("a disconnected state keeps toasts raised beforehand", async () => {
    await wireEvents();
    useAppStore.setState({ ...useAppStore.getState(), connection: { ...initialState().connection, context: "prod", state: "connected" } });
    hoisted.handlers!.connection_error({ kind: "auth", message: "token expired" });
    hoisted.handlers!.connection_state("disconnected");
    const s = useAppStore.getState();
    expect(s.connection.state).toBe("disconnected");
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0]).toMatchObject({ kind: "auth", message: "token expired" });
  });

  it("a disconnected state while a connect is in flight does not reset the store", async () => {
    // connect() tears the old session down first; the resulting "disconnected" belongs to the
    // reconnect in progress, whose outcome connect() itself will write.
    await wireEvents();
    useAppStore.setState({ ...useAppStore.getState(), connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["p"], busy: true } });
    hoisted.handlers!.graph_snapshot({ nodes: [node], edges: [] });
    hoisted.handlers!.connection_state("disconnected");
    const s = useAppStore.getState();
    expect(s.connection.state).toBe("disconnected");
    expect(s.connection.context).toBe("prod");
    expect(s.connection.busy).toBe(true);
    expect(s.nodes.size).toBe(1);
    expect(s.pickerOpen).toBe(false);
  });

  it("refreshes denied kinds when a per-kind forbidden error arrives", async () => {
    const { invoke } = await import("../shared/ipc/tauri");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "denied_kinds" ? ["Secret"] : null));
    await wireEvents();
    hoisted.handlers!.connection_error({ kind: "forbidden", message: "Secret: forbidden" });
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().deniedKinds.has("Secret")).toBe(true);
  });
});

describe("deltaTouches for hidden ReplicaSets", () => {
  it("treats Deployment and Pod changes as touching the ReplicaSet table", () => {
    const dep = { id: "Deployment/p/web", kind: "Deployment" as const, namespace: "p", name: "web", status: "ok" as const, badges: [], group: null };
    const d = { addedNodes: [], updatedNodes: [dep], removedNodes: [], addedEdges: [], removedEdges: [] };
    expect(deltaTouches(d, "ReplicaSet")).toBe(true);
    expect(deltaTouches({ ...d, updatedNodes: [], removedNodes: ["Pod/p/web-1"] }, "ReplicaSet")).toBe(true);
    expect(deltaTouches(d, "Service")).toBe(false);
  });
});

describe("deltaTouches", () => {
  it("matches added, updated and removed nodes of the given kind", () => {
    expect(deltaTouches(emptyDelta, "Pod")).toBe(false);
    expect(deltaTouches({ ...emptyDelta, addedNodes: [node] }, "Pod")).toBe(true);
    expect(deltaTouches({ ...emptyDelta, updatedNodes: [node] }, "Pod")).toBe(true);
    expect(deltaTouches({ ...emptyDelta, removedNodes: ["Pod/p/a"] }, "Pod")).toBe(true);
    expect(deltaTouches({ ...emptyDelta, addedNodes: [{ ...node, id: "Service/p/s", kind: "Service" }] }, "Pod")).toBe(false);
  });

  it("a touched PodGroup also counts as touching the Pod table, but no other kind", () => {
    expect(deltaTouches({ ...emptyDelta, addedNodes: [podGroupNode] }, "Pod")).toBe(true);
    expect(deltaTouches({ ...emptyDelta, updatedNodes: [podGroupNode] }, "Pod")).toBe(true);
    expect(deltaTouches({ ...emptyDelta, removedNodes: ["PodGroup/p/Deployment/w"] }, "Pod")).toBe(true);
    expect(deltaTouches({ ...emptyDelta, addedNodes: [podGroupNode] }, "Service")).toBe(false);
  });
});

describe("table refresh", () => {
  it("refreshes the open table on graph_snapshot", async () => {
    const { invoke } = await import("../shared/ipc/tauri");
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      (cmd === "list_rows" ? { kind: args.kind, columns: [], rows: [] } : null));
    await wireEvents();
    useAppStore.setState({ view: { name: "table", kind: "Pod" } });
    hoisted.handlers!.graph_snapshot({ nodes: [node], edges: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).toHaveBeenCalledWith("list_rows", { kind: "Pod" });
  });

  it("does not refresh a table while the graph view is active", async () => {
    const { invoke } = await import("../shared/ipc/tauri");
    await wireEvents();
    useAppStore.setState({ view: { name: "graph" } });
    hoisted.handlers!.graph_snapshot({ nodes: [node], edges: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalledWith("list_rows", expect.anything());
  });

  it("debounces graph_delta refreshes touching the open table's kind, trailing 300ms", async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = await import("../shared/ipc/tauri");
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
        (cmd === "list_rows" ? { kind: args.kind, columns: [], rows: [] } : null));
      await wireEvents();
      useAppStore.setState({ view: { name: "table", kind: "Pod" } });

      hoisted.handlers!.graph_delta({ ...emptyDelta, addedNodes: [node] });
      await vi.advanceTimersByTimeAsync(200);
      hoisted.handlers!.graph_delta({ ...emptyDelta, addedNodes: [{ ...node, id: "Pod/p/b" }] });
      expect(invoke).not.toHaveBeenCalledWith("list_rows", expect.anything());

      await vi.advanceTimersByTimeAsync(300);
      expect(invoke).toHaveBeenCalledWith("list_rows", { kind: "Pod" });
      expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "list_rows")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a delta that does not touch the open table's kind", async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = await import("../shared/ipc/tauri");
      await wireEvents();
      useAppStore.setState({ view: { name: "table", kind: "Pod" } });
      hoisted.handlers!.graph_delta({ ...emptyDelta, addedNodes: [{ ...node, id: "Service/p/s", kind: "Service" }] });
      await vi.advanceTimersByTimeAsync(300);
      expect(invoke).not.toHaveBeenCalledWith("list_rows", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("a disconnect cancels a pending debounced refresh", async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = await import("../shared/ipc/tauri");
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
        (cmd === "list_rows" ? { kind: args.kind, columns: [], rows: [] } : null));
      await wireEvents();
      useAppStore.setState({
        view: { name: "table", kind: "Pod" },
        connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["a"] },
      });
      hoisted.handlers!.graph_delta({ ...emptyDelta, addedNodes: [node] });
      hoisted.handlers!.connection_state("disconnected");
      await vi.advanceTimersByTimeAsync(300);
      expect(invoke).not.toHaveBeenCalledWith("list_rows", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("a namespace switch cancels a pending debounced refresh for the old namespace", async () => {
    vi.useFakeTimers();
    try {
      const { invoke } = await import("../shared/ipc/tauri");
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
        (cmd === "list_rows" ? { kind: args.kind, columns: [], rows: [] } : null));
      await wireEvents();
      useAppStore.setState({
        view: { name: "table", kind: "Pod" },
        connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["a"] },
      });
      hoisted.handlers!.graph_delta({ ...emptyDelta, addedNodes: [node] });
      // selectNamespace cancels the pending debounce; the new namespace's rows are fetched only
      // once its graph_snapshot arrives, so no list_rows call may happen in between.
      await useAppStore.getState().selectNamespace("b");
      await vi.advanceTimersByTimeAsync(300);
      expect(invoke).not.toHaveBeenCalledWith("list_rows", expect.anything());
      expect(useAppStore.getState().connection.scope).toEqual(["b"]);
      hoisted.handlers!.graph_snapshot({ nodes: [{ ...node, id: "Pod/b/x", namespace: "b" }], edges: [] });
      expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "list_rows")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("metrics_updated", () => {
  beforeEach(() => { vi.useFakeTimers(); cancelDetailsRefresh(); vi.mocked(invoke).mockClear(); });
  afterEach(() => vi.useRealTimers());

  it("refetches an open pod or workload table, not other tables", async () => {
    await wireEvents();
    const refreshTable = vi.fn(async () => {});
    useAppStore.setState({ refreshTable, view: { name: "table", kind: "Deployment" } });
    hoisted.handlers!.metrics_updated({ state: "available" });
    vi.advanceTimersByTime(TABLE_REFRESH_DEBOUNCE_MS);
    expect(refreshTable).toHaveBeenCalledWith("Deployment");
    refreshTable.mockClear();
    useAppStore.setState({ view: { name: "table", kind: "Service" } });
    hoisted.handlers!.metrics_updated({ state: "available" });
    vi.advanceTimersByTime(TABLE_REFRESH_DEBOUNCE_MS);
    expect(refreshTable).not.toHaveBeenCalled();
  });

  it("does not refetch a table the user left before the debounce fired", async () => {
    await wireEvents();
    const refreshTable = vi.fn(async () => {});
    useAppStore.setState({ refreshTable, view: { name: "table", kind: "Pod" } });
    hoisted.handlers!.metrics_updated({ state: "available" });
    useAppStore.setState({ view: { name: "graph" } });
    vi.advanceTimersByTime(TABLE_REFRESH_DEBOUNCE_MS);
    expect(refreshTable).not.toHaveBeenCalled();
  });

  it("reloads the selected details", async () => {
    await wireEvents();
    const data = { yaml: "kind: Pod", summary: [], related: [] };
    useAppStore.setState({ selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data, events: [], loading: false, editor: viewEditor(data.yaml) } });
    hoisted.handlers!.metrics_updated({ state: "available" });
    await vi.runAllTimersAsync();
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "get_object")).toEqual([["get_object", { nodeId: "Pod/p/a" }]]);
  });

  it("leaves the details of a kind without usage alone", async () => {
    await wireEvents();
    const data = { yaml: "kind: Service", summary: [], related: [] };
    useAppStore.setState({ selectedId: "Service/p/s", details: { nodeId: "Service/p/s", data, events: [], loading: false, editor: viewEditor(data.yaml) } });
    hoisted.handlers!.metrics_updated({ state: "available" });
    await vi.runAllTimersAsync();
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "get_object")).toEqual([]);
  });
});

describe("update events", () => {
  it("routes download progress into the update store and the menu item into a manual check", async () => {
    const { initialUpdateState, useUpdateStore } = await import("../features/update/updateStore");
    useUpdateStore.setState(initialUpdateState());
    const stop = await wireEvents();
    hoisted.handlers!.update_progress({ downloaded: 10, total: 100 });
    expect(useUpdateStore.getState().progress).toEqual({ downloaded: 10, total: 100 });
    vi.mocked(invoke).mockResolvedValueOnce({ current: "0.2.0", update: null });
    hoisted.handlers!.menu_check_updates(null);
    await vi.waitFor(() => expect(useAppStore.getState().toasts.at(-1)?.message).toBe("Wiring 0.2.0 is up to date"));
    stop();
  });
});
