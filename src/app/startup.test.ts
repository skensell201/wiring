import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "./store";

const { mem } = vi.hoisted(() => ({ mem: new Map<string, unknown>() }));
vi.mock("../shared/settings", () => ({
  settings: {
    get: vi.fn(async (k: string) => mem.get(k) ?? null),
    set: vi.fn(async (k: string, v: string | null) => { mem.set(k, v); }),
    getLastNamespace: vi.fn(async (ctx: string) => mem.get(`ns:${ctx}`) ?? null),
    setLastNamespace: vi.fn(async (ctx: string, ns: string) => { mem.set(`ns:${ctx}`, ns); }),
    getSidebarCollapsed: vi.fn(async () => mem.get("sidebarCollapsed") ?? false),
    setSidebarCollapsed: vi.fn(async (v: boolean) => { mem.set("sidebarCollapsed", v); }),
  },
}));
vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "list_contexts") return [{ name: "prod", cluster: "c", user: "u", namespace: "payments", sourceFile: "/k" }];
    if (cmd === "connect") return { context: "prod", serverVersion: "v1", namespaces: ["default", "payments"] };
    if (cmd === "denied_kinds") return [];
    return null;
  }),
  listen: vi.fn(async () => () => {}),
}));

import { invoke } from "../shared/ipc/tauri";
import { startup } from "./startup";

beforeEach(() => { useAppStore.setState(initialState()); mem.clear(); vi.mocked(invoke).mockClear(); });

describe("startup", () => {
  it("opens the picker when there is no remembered context", async () => {
    await startup();
    expect(useAppStore.getState().pickerOpen).toBe(true);
    expect(useAppStore.getState().contexts).toHaveLength(1);
  });

  it("auto-connects the remembered context and namespace", async () => {
    mem.set("lastContext", "prod");
    mem.set("ns:prod", "payments");
    mem.set("ns:staging", "default"); // another context's memory must not leak in
    await startup();
    const s = useAppStore.getState();
    expect(s.pickerOpen).toBe(false);
    expect(s.connection.context).toBe("prod");
    expect(s.connection.namespace).toBe("payments");
    expect(invoke).toHaveBeenCalledWith("select_namespace", { namespace: "payments", expandedGroups: [] });
  });

  it("falls back to the context's default namespace", async () => {
    mem.set("lastContext", "prod");
    mem.set("ns:staging", "default");
    await startup();
    expect(useAppStore.getState().connection.namespace).toBe("payments");
  });

  it("opens the picker when the remembered context no longer exists", async () => {
    mem.set("lastContext", "gone");
    await startup();
    expect(useAppStore.getState().pickerOpen).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("connect", expect.anything());
  });

  it("loads the persisted sidebar-collapsed flag before connecting", async () => {
    mem.set("sidebarCollapsed", true);
    await startup();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });

  it("opens the picker when connecting the remembered context fails", async () => {
    mem.set("lastContext", "prod");
    vi.mocked(invoke).mockImplementationOnce(async (cmd: string) => {
      if (cmd === "list_contexts") return [{ name: "prod", cluster: "c", user: "u", namespace: "payments", sourceFile: "/k" }];
      return null;
    });
    vi.mocked(invoke).mockImplementationOnce(async () => { throw new Error("connect failed"); });
    await startup();
    expect(useAppStore.getState().pickerOpen).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("select_namespace", expect.anything());
  });
});
