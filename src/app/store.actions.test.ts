import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "get_object" ? { yaml: "kind: Deployment\n", summary: [], related: [] } : null)),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));
vi.mock("../shared/settings", () => ({
  settings: {
    get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastNamespace: vi.fn(async () => null), setLastNamespace: vi.fn(async () => {}),
    getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}),
  },
}));

import { invoke } from "../shared/ipc/tauri";
import { initialState, useAppStore, viewEditor } from "./store";

const WEB = "Deployment/p/web";
const fresh = { yaml: "kind: Deployment\nspec:\n  replicas: 5\n", summary: [["Name", "web"]] as [string, string][], related: [] };
const selectWeb = (mode: "view" | "edit" = "view") => useAppStore.setState({
  selectedId: WEB,
  details: { nodeId: WEB, data: { yaml: "old", summary: [], related: [] }, events: [], loading: false, editor: mode === "view" ? viewEditor("old") : { ...viewEditor("old"), mode: "edit", buffer: "mine" } },
});

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockClear();
});

describe("actions menu", () => {
  it("opens at the pointer and selects the object", async () => {
    useAppStore.getState().openActionsMenu(WEB, 10, 20);
    expect(useAppStore.getState().actionsMenu).toEqual({ nodeId: WEB, x: 10, y: 20 });
    await vi.waitFor(() => expect(useAppStore.getState().selectedId).toBe(WEB));
    useAppStore.getState().closeActionsMenu();
    expect(useAppStore.getState().actionsMenu).toBeNull();
  });

  it("stays closed when leaving a dirty editor needs confirmation first", () => {
    selectWeb("edit");
    useAppStore.getState().openActionsMenu("StatefulSet/p/db", 0, 0);
    expect(useAppStore.getState().discardDialog.open).toBe(true);
    expect(useAppStore.getState().actionsMenu).toBeNull();
  });

  it("requested details tabs are handed over once", () => {
    useAppStore.getState().requestTab("history");
    expect(useAppStore.getState().requestedTab).toBe("history");
    useAppStore.getState().consumeRequestedTab();
    expect(useAppStore.getState().requestedTab).toBeNull();
  });
});

describe("rollout actions", () => {
  it("scaleObject calls the backend, refreshes the details, closes the dialog and toasts", async () => {
    selectWeb();
    useAppStore.getState().openActionDialog({ type: "scale", nodeId: WEB });
    vi.mocked(invoke).mockResolvedValueOnce(fresh);
    await useAppStore.getState().scaleObject(WEB, 5);
    expect(invoke).toHaveBeenCalledWith("scale_object", { nodeId: WEB, replicas: 5 });
    const s = useAppStore.getState();
    expect(s.actionDialog).toBeNull();
    expect(s.actionBusy).toBe(false);
    expect(s.details?.data).toEqual(fresh);
    expect(s.details?.editor).toEqual(viewEditor(fresh.yaml));
    expect(s.toasts.at(-1)).toMatchObject({ kind: "info", message: "Scaled Deployment web to 5" });
  });

  it("does not overwrite an edit in progress", async () => {
    selectWeb("edit");
    vi.mocked(invoke).mockResolvedValueOnce(fresh);
    await useAppStore.getState().restartObject(WEB);
    expect(invoke).toHaveBeenCalledWith("restart_object", { nodeId: WEB });
    expect(useAppStore.getState().details?.editor.buffer).toBe("mine");
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Restarted Deployment web" });
  });

  it("rollbackObject names the revision", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(fresh);
    await useAppStore.getState().rollbackObject(WEB, 3);
    expect(invoke).toHaveBeenCalledWith("rollback_object", { nodeId: WEB, revision: 3 });
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Rolled Deployment web back to revision 3" });
  });

  it("a failure is toasted and closes the dialog", async () => {
    useAppStore.getState().openActionDialog({ type: "restart", nodeId: WEB });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "invalid", message: "deployment is paused; resume it first" });
    await useAppStore.getState().restartObject(WEB);
    expect(useAppStore.getState().actionDialog).toBeNull();
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "invalid", message: "deployment is paused; resume it first" });
  });

  it("ignores a second action while one is in flight", async () => {
    useAppStore.setState({ actionBusy: true });
    await useAppStore.getState().scaleObject(WEB, 2);
    expect(invoke).not.toHaveBeenCalled();
  });
});
