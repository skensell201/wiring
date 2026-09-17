import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandlers } from "../shared/ipc/events";
import { initialState, useAppStore } from "./store";

// vi.mock is hoisted above imports, so shared state must be hoisted too.
const hoisted = vi.hoisted(() => ({ handlers: null as EventHandlers | null }));
vi.mock("../shared/ipc/events", () => ({
  listenAll: vi.fn(async (h: EventHandlers) => { hoisted.handlers = h; return () => { hoisted.handlers = null; }; }),
}));
vi.mock("../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));

import { wireEvents } from "./wireEvents";

const node = { id: "Pod/p/a", kind: "Pod" as const, namespace: "p", name: "a", status: "ok" as const, badges: [], group: null };

beforeEach(() => { useAppStore.setState(initialState()); hoisted.handlers = null; });

describe("wireEvents", () => {
  it("routes snapshot, delta, connection state, object events and errors into the store", async () => {
    const stop = await wireEvents();
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "p" } });
    hoisted.handlers!.graph_snapshot({ nodes: [node], edges: [] });
    expect(useAppStore.getState().nodes.size).toBe(1);
    hoisted.handlers!.graph_delta({ addedNodes: [{ ...node, id: "Pod/p/b", name: "b" }], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });
    expect(useAppStore.getState().nodes.size).toBe(2);
    hoisted.handlers!.connection_state("degraded");
    expect(useAppStore.getState().connection.state).toBe("degraded");
    useAppStore.setState({ selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data: null, events: [], loading: false } });
    hoisted.handlers!.object_events({ nodeId: "Pod/p/a", events: [{ name: "e", type: "Normal", reason: "Scheduled", message: "ok", count: 1, firstTimestamp: null, lastTimestamp: null }] });
    expect(useAppStore.getState().details?.events).toHaveLength(1);
    hoisted.handlers!.object_events({ nodeId: "Pod/p/zzz", events: [] });
    expect(useAppStore.getState().details?.events).toHaveLength(1); // ignored: not the selection
    hoisted.handlers!.connection_error({ kind: "forbidden", message: "Secret: forbidden" });
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "forbidden" });
    stop();
    expect(hoisted.handlers).toBeNull();
  });

  it("a disconnected state reopens the context picker and clears the graph", async () => {
    await wireEvents();
    useAppStore.setState({ ...useAppStore.getState(), connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "p" } });
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
    useAppStore.setState({ ...useAppStore.getState(), connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "p", busy: true } });
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
