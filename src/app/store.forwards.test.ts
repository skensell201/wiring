import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));
vi.mock("../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastNamespace: vi.fn(async () => null), setLastNamespace: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
}));

import { invoke } from "../shared/ipc/tauri";
import type { Forward } from "../shared/ipc/types";
import { initialState, useAppStore } from "./store";

const WEB = "Service/p/web";
const fwd: Forward = { id: 1, nodeId: WEB, targetLabel: "Service web", remotePort: 80, localPort: 8080, pod: null, status: "active", message: null };

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async () => null);
});

describe("port-forwards", () => {
  it("start adds the forward, closes its dialog and says so", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) => (cmd === "start_forward" ? fwd : null)) as typeof invoke);
    useAppStore.setState({ actionDialog: { type: "forward", nodeId: WEB } });
    const err = await useAppStore.getState().startForward(WEB, 80, 8080);
    expect(err).toBeNull();
    expect(invoke).toHaveBeenCalledWith("start_forward", { nodeId: WEB, remotePort: 80, localPort: 8080 });
    const s = useAppStore.getState();
    expect(s.forwards).toEqual([fwd]);
    expect(s.actionDialog).toBeNull();
    expect(s.toasts.at(-1)).toMatchObject({ kind: "info", message: "Forwarding localhost:8080 → Service web:80" });
  });

  it("a failed start returns the error and keeps the dialog", async () => {
    vi.mocked(invoke).mockImplementation((async () => { throw { kind: "conflict", message: "port 8080 is already in use" }; }) as typeof invoke);
    useAppStore.setState({ actionDialog: { type: "forward", nodeId: WEB } });
    const err = await useAppStore.getState().startForward(WEB, 80, 8080);
    expect(err).toEqual({ kind: "conflict", message: "port 8080 is already in use" });
    expect(useAppStore.getState().actionDialog).toEqual({ type: "forward", nodeId: WEB });
    expect(useAppStore.getState().forwards).toEqual([]);
  });

  it("an event that already listed the forward is not duplicated by the start result", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "start_forward") useAppStore.getState().setForwards([{ ...fwd, pod: "web-1" }]);
      return cmd === "start_forward" ? fwd : null;
    }) as typeof invoke);
    await useAppStore.getState().startForward(WEB, 80, 8080);
    expect(useAppStore.getState().forwards).toEqual([{ ...fwd, pod: "web-1" }]);
  });

  it("stop removes the forward; the popover closes when none is left", async () => {
    useAppStore.setState({ forwards: [fwd], forwardsOpen: true });
    await useAppStore.getState().stopForward(1);
    expect(invoke).toHaveBeenCalledWith("stop_forward", { id: 1 });
    expect(useAppStore.getState().forwards).toEqual([]);
    expect(useAppStore.getState().forwardsOpen).toBe(false);
  });

  it("open asks the backend to open the forward", async () => {
    await useAppStore.getState().openForward(1);
    expect(invoke).toHaveBeenCalledWith("open_forward", { id: 1 });
  });

  it("forwards survive a namespace switch", async () => {
    useAppStore.setState({ forwards: [fwd], connection: { ...initialState().connection, context: "c", state: "connected" } });
    await useAppStore.getState().selectNamespace("other");
    expect(useAppStore.getState().forwards).toEqual([fwd]);
  });

  it("forwards are cleared on disconnect", async () => {
    useAppStore.setState({ forwards: [fwd], forwardsOpen: true });
    await useAppStore.getState().disconnect();
    expect(useAppStore.getState().forwards).toEqual([]);
    expect(useAppStore.getState().forwardsOpen).toBe(false);
  });
});
