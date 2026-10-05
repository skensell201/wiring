import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));
vi.mock("../shared/settings", () => ({
  settings: {
    get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastNamespace: vi.fn(async () => null), setLastNamespace: vi.fn(async () => {}),
    getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}),
  },
}));

import type { GraphDelta, GraphEdge, GraphNode } from "../shared/ipc/types";
import { invoke } from "../shared/ipc/tauri";
import { cancelDetailsRefresh, initialState, useAppStore, viewEditor } from "./store";

const node = (id: string, kind: GraphNode["kind"], replicas = 1): GraphNode =>
  ({ id, kind, namespace: "p", name: id.split("/").pop()!, status: "ok", badges: [`${replicas}/${replicas}`], group: null });
const WEB = "Deployment/p/web";
const OTHER = "Service/p/other";
const edge = (source: string, target: string): GraphEdge => ({ id: `${source}->${target}`, source, target, relation: "owns" });
const delta = (d: Partial<GraphDelta>): GraphDelta => ({ addedNodes: [], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [], ...d });
const fresh = (n: number) => ({ yaml: `fresh ${n}`, summary: [], related: [] });
const getObjectCalls = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "get_object").length;

let clock = 1_000_000;
function setup(mode: "view" | "edit" = "view") {
  const nodes = new Map([node(WEB, "Deployment"), node(OTHER, "Service")].map((x) => [x.id, x]));
  const old = edge(WEB, "PodGroup/p/g");
  useAppStore.setState({
    ...initialState(), graphReady: true, connection: { ...initialState().connection, namespace: "p" }, nodes, edges: new Map([[old.id, old]]),
    selectedId: WEB,
    details: { nodeId: WEB, data: { yaml: "old", summary: [], related: [] }, events: [], loading: false,
      editor: mode === "view" ? viewEditor("old") : { ...viewEditor("old"), mode: "edit", buffer: "mine" } },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  clock += 10_000;
  vi.setSystemTime(clock);
  cancelDetailsRefresh();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(fresh(1));
});
afterEach(() => { cancelDetailsRefresh(); vi.useRealTimers(); });

describe("details refresh on graph changes", () => {
  it("reloads the selected object once when its node is updated", async () => {
    setup();
    useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 2)] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getObjectCalls()).toBe(1);
    expect(useAppStore.getState().details?.data?.yaml).toBe("fresh 1");
    expect(invoke).not.toHaveBeenCalledWith("watch_events", expect.anything());
  });

  it("reloads when an edge touching the selected node is added or removed", async () => {
    setup();
    useAppStore.getState().applyDelta(delta({ removedEdges: [`${WEB}->PodGroup/p/g`] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getObjectCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    useAppStore.getState().applyDelta(delta({ addedEdges: [edge(WEB, "Pod/p/x")] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getObjectCalls()).toBe(2);
  });

  it("coalesces a burst of deltas into one leading and one trailing reload", async () => {
    setup();
    for (let i = 2; i < 7; i++) useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", i)] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getObjectCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getObjectCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(getObjectCalls()).toBe(2);
  });

  it("does not reload while editing or reviewing", async () => {
    setup("edit");
    useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 2)] }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(getObjectCalls()).toBe(0);
    expect(useAppStore.getState().details?.editor.buffer).toBe("mine");
  });

  it("does not apply a trailing reload when an edit started meanwhile", async () => {
    setup();
    useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 2)] }));
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 3)] }));
    useAppStore.setState((s) => ({ details: { ...s.details!, editor: { ...s.details!.editor, mode: "edit", buffer: "mine" } } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(getObjectCalls()).toBe(1);
    expect(useAppStore.getState().details?.editor.buffer).toBe("mine");
  });

  it("ignores deltas that do not touch the selected node", async () => {
    setup();
    useAppStore.getState().applyDelta(delta({
      updatedNodes: [node(OTHER, "Service", 2)], addedNodes: [node("Pod/p/y", "Pod")], addedEdges: [edge(OTHER, "Pod/p/y")], removedEdges: ["nope"],
    }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(getObjectCalls()).toBe(0);
  });

  it("drops a result that arrives after the selection changed", async () => {
    setup();
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 2)] }));
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.setState({ selectedId: OTHER, details: { nodeId: OTHER, data: { yaml: "other", summary: [], related: [] }, events: [], loading: false, editor: viewEditor("other") } });
    resolve(fresh(9));
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().details?.data?.yaml).toBe("other");
  });

  it("a snapshot that changes the selected node also reloads", async () => {
    setup();
    useAppStore.getState().applySnapshot({ nodes: [node(WEB, "Deployment", 2), node(OTHER, "Service")], edges: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(getObjectCalls()).toBe(1);
  });

  it("keeps the details object when the reload brings nothing new", async () => {
    setup();
    vi.mocked(invoke).mockResolvedValue({ yaml: "old", summary: [], related: [] });
    const before = useAppStore.getState().details;
    useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 2)] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getObjectCalls()).toBe(1);
    expect(useAppStore.getState().details).toBe(before);
  });

  describe("with a text selection in the details panel", () => {
    afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });
    const select = (text: string, inside: boolean) => {
      const panel = document.createElement("section");
      panel.setAttribute("data-details-panel", "");
      const span = document.createElement("span");
      panel.appendChild(span);
      const outside = document.createElement("div");
      document.body.append(panel, outside);
      vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => text, anchorNode: inside ? span : outside } as unknown as Selection);
    };

    it("does not apply a changed reload; the next change retries", async () => {
      setup();
      select("abc", true);
      useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 2)] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(getObjectCalls()).toBe(1);
      expect(useAppStore.getState().details?.data?.yaml).toBe("old");
      vi.mocked(window.getSelection).mockReturnValue({ toString: () => "", anchorNode: null } as unknown as Selection);
      await vi.advanceTimersByTimeAsync(1000);
      useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 3)] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(useAppStore.getState().details?.data?.yaml).toBe("fresh 1");
    });

    it("applies the reload when the selection is elsewhere", async () => {
      setup();
      select("abc", false);
      useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 2)] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(useAppStore.getState().details?.data?.yaml).toBe("fresh 1");
    });
  });

  it("cancels a pending reload on namespace switch, disconnect and deselect", async () => {
    for (const leave of [
      () => useAppStore.getState().selectNamespace("q"),
      () => useAppStore.getState().disconnect(),
      () => useAppStore.getState().select(null),
    ]) {
      cancelDetailsRefresh();
      vi.mocked(invoke).mockClear();
      setup();
      useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 2)] }));
      await vi.advanceTimersByTimeAsync(0);
      useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 3)] }));
      await leave();
      // Back on the same object: a stale timer would swallow this change until it fires.
      setup();
      useAppStore.getState().applyDelta(delta({ updatedNodes: [node(WEB, "Deployment", 4)] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(getObjectCalls()).toBe(2);
    }
  });
});
