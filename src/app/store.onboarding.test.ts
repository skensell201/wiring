import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeconfigSource } from "../shared/ipc/types";

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));
vi.mock("../shared/settings", () => ({
  settings: {
    get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}),
    getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}),
  },
}));

import { invoke } from "../shared/ipc/tauri";
import { initialState, useAppStore } from "./store";

const INFO = { context: "prod", serverVersion: "v1.33.0", namespaces: ["default", "shop"], canListNamespaces: true };
const PROD = { name: "prod", cluster: "c", user: "u", namespace: "shop", sourceFile: "/k" };
const SOURCES: KubeconfigSource[] = [{ path: "/k", origin: "default", state: "ok", contexts: 1, error: null }];
const answer = (cmd: string): unknown => {
  if (cmd === "connect") return INFO;
  if (cmd === "list_contexts") return [PROD];
  if (cmd === "kubeconfig_sources") return SOURCES;
  if (cmd === "denied_kinds" || cmd === "partial_kinds") return [];
  return null;
};
const called = () => vi.mocked(invoke).mock.calls.map((c) => c[0]);

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => answer(cmd));
});

describe("connecting and the last error", () => {
  it("marks the context being dialled until connect settles", async () => {
    let resolve!: (v: typeof INFO) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((r) => { resolve = r as typeof resolve; }));
    const pending = useAppStore.getState().connect("prod");
    expect(useAppStore.getState().connection).toMatchObject({ connecting: "prod", busy: true, lastError: null });
    resolve(INFO);
    expect(await pending).toBe(true);
    expect(useAppStore.getState().connection).toMatchObject({ connecting: null, busy: false, context: "prod", lastError: null });
  });

  it("keeps a failed connect as the last error, and the next connect clears it", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "network", message: "timed out after 20 s waiting for https://k" });
    expect(await useAppStore.getState().connect("prod")).toBe(false);
    expect(useAppStore.getState().connection).toMatchObject({
      connecting: null, busy: false, context: null,
      lastError: { context: "prod", error: { kind: "network", message: "timed out after 20 s waiting for https://k" } },
    });
    expect(useAppStore.getState().toasts).toEqual([]);
    const pending = useAppStore.getState().connect("prod");
    expect(useAppStore.getState().connection.lastError).toBeNull();
    await pending;
  });

  it("a superseded connect's late failure does not land over the newer connection", async () => {
    let reject!: (e: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
    const first = useAppStore.getState().connect("staging");
    expect(await useAppStore.getState().connect("prod")).toBe(true);
    reject({ kind: "network", message: "late" });
    expect(await first).toBe(false);
    expect(useAppStore.getState().connection).toMatchObject({ state: "connected", context: "prod", connecting: null, lastError: null });
  });

  it("a superseded connect's late success does not replace the newer one", async () => {
    let resolve!: (v: typeof INFO) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((r) => { resolve = r as typeof resolve; }));
    const first = useAppStore.getState().connect("staging");
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "auth", message: "no" });
    expect(await useAppStore.getState().connect("prod")).toBe(false);
    resolve({ ...INFO, context: "staging" });
    expect(await first).toBe(false);
    expect(useAppStore.getState().connection).toMatchObject({ state: "disconnected", context: null, lastError: { context: "prod" } });
  });

  it("a connect in flight when the user disconnects does not land afterwards", async () => {
    let resolve!: (v: typeof INFO) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((r) => { resolve = r as typeof resolve; }));
    const pending = useAppStore.getState().connect("prod");
    await useAppStore.getState().disconnect();
    resolve(INFO);
    expect(await pending).toBe(false);
    expect(useAppStore.getState().connection).toEqual(initialState().connection);
  });

  it("disconnect clears the last error", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, lastError: { context: "prod", error: { kind: "auth", message: "no" } } } });
    await useAppStore.getState().disconnect();
    expect(useAppStore.getState().connection.lastError).toBeNull();
  });

  it("retryConnect reconnects the failed context and opens its namespace", async () => {
    useAppStore.setState({ contexts: [PROD], connection: { ...initialState().connection, lastError: { context: "prod", error: { kind: "auth", message: "no" } } } });
    await useAppStore.getState().retryConnect();
    expect(invoke).toHaveBeenCalledWith("connect", { context: "prod" });
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: ["shop"], expandedGroups: [] });
    expect(useAppStore.getState().connection).toMatchObject({ context: "prod", lastError: null });
  });

  it("retryConnect does nothing while a connect is in flight", async () => {
    useAppStore.setState({ contexts: [PROD], connection: { ...initialState().connection, connecting: "prod", lastError: { context: "prod", error: { kind: "auth", message: "no" } } } });
    await useAppStore.getState().retryConnect();
    expect(called()).not.toContain("connect");
  });

  it("retryConnect leaves the failure pane when the failed context is gone", async () => {
    useAppStore.setState({ contexts: [], sidebarCollapsed: true, connection: { ...initialState().connection, lastError: { context: "prod", error: { kind: "auth", message: "no" } } } });
    await useAppStore.getState().retryConnect();
    expect(called()).not.toContain("connect");
    expect(useAppStore.getState().connection.lastError).toBeNull();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });

  it("dismissConnectError clears the error and opens a collapsed navigator", async () => {
    useAppStore.setState({ sidebarCollapsed: true, connection: { ...initialState().connection, lastError: { context: "prod", error: { kind: "auth", message: "no" } } } });
    await useAppStore.getState().dismissConnectError();
    expect(useAppStore.getState().connection.lastError).toBeNull();
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
  });
});

describe("kubeconfig sources", () => {
  it("loads them, and keeps them across a connect and a disconnect", async () => {
    await useAppStore.getState().loadKubeconfigSources();
    expect(useAppStore.getState().kubeconfigSources).toEqual(SOURCES);
    await useAppStore.getState().connect("prod");
    expect(useAppStore.getState().kubeconfigSources).toEqual(SOURCES);
    await useAppStore.getState().disconnect();
    expect(useAppStore.getState().kubeconfigSources).toEqual(SOURCES);
  });

  it("treats a missing answer as no sources and toasts a failure", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await useAppStore.getState().loadKubeconfigSources();
    expect(useAppStore.getState().kubeconfigSources).toEqual([]);
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "internal", message: "boom" });
    await useAppStore.getState().loadKubeconfigSources();
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "internal", message: "boom" });
  });

  it("rescan re-reads the contexts and the sources", async () => {
    await useAppStore.getState().rescanKubeconfigs();
    expect(called()).toEqual(expect.arrayContaining(["list_contexts", "kubeconfig_sources"]));
    expect(useAppStore.getState().contexts).toEqual([PROD]);
    expect(useAppStore.getState().kubeconfigSources).toEqual(SOURCES);
  });
});

describe("empty-state actions", () => {
  it("openNamespacePicker bumps the request counter", () => {
    const before = useAppStore.getState().namespacePickerSeq;
    useAppStore.getState().openNamespacePicker();
    expect(useAppStore.getState().namespacePickerSeq).toBe(before + 1);
  });

  it("showAllKinds turns every chip on", () => {
    expect(useAppStore.getState().hiddenKinds.size).toBeGreaterThan(0);
    useAppStore.getState().showAllKinds();
    expect(useAppStore.getState().hiddenKinds.size).toBe(0);
  });
});

describe("too-large switch notice", () => {
  const big = { nodes: [], edges: [], tooLarge: { nodes: 1873, kinds: [] } };
  const notices = () => useAppStore.getState().toasts.filter((t) => t.message.includes("too many to draw"));

  it("says so once per scope when the graph switches to a table", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop"] } });
    useAppStore.getState().applySnapshot(big);
    expect(useAppStore.getState().view).toEqual({ name: "table", kind: "Deployment" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ kind: "info", message: expect.stringContaining("1,873 objects") });

    // Back to the graph, another rebuild of the same scope: switched again, not said again.
    useAppStore.getState().showGraph();
    useAppStore.getState().applySnapshot(big);
    expect(useAppStore.getState().view.name).toBe("table");
    expect(notices()).toHaveLength(1);

    useAppStore.setState((s) => ({ connection: { ...s.connection, scope: "all" } }));
    useAppStore.getState().showGraph();
    useAppStore.getState().applySnapshot(big);
    expect(notices()).toHaveLength(2);
  });

  it("says nothing when a table was already on screen", () => {
    useAppStore.setState({ view: { name: "table", kind: "Pod" }, connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop"] } });
    useAppStore.getState().applySnapshot(big);
    expect(notices()).toHaveLength(0);
  });
});
