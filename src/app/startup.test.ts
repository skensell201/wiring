import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "./store";

const { mem } = vi.hoisted(() => ({ mem: new Map<string, unknown>() }));
vi.mock("../shared/settings", () => ({
  settings: {
    get: vi.fn(async (k: string) => mem.get(k) ?? null),
    set: vi.fn(async (k: string, v: string | null) => { mem.set(k, v); }),
    getLastScope: vi.fn(async (ctx: string) => mem.get(`scope:${ctx}`) ?? null),
    setLastScope: vi.fn(async (ctx: string, scope: unknown) => { mem.set(`scope:${ctx}`, scope); }),
    getSidebarCollapsed: vi.fn(async () => mem.get("sidebarCollapsed") ?? false),
    setSidebarCollapsed: vi.fn(async (v: boolean) => { mem.set("sidebarCollapsed", v); }),
    getDetailsHeight: vi.fn(async () => (mem.get("detailsHeight") as number | undefined) ?? null),
    setDetailsHeight: vi.fn(async (v: number) => { mem.set("detailsHeight", v); }),
  },
}));
vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "list_contexts") return [{ name: "prod", cluster: "c", user: "u", namespace: "payments", sourceFile: "/k" }];
    if (cmd === "connect") return { context: "prod", serverVersion: "v1", namespaces: ["default", "payments"], canListNamespaces: true };
    if (cmd === "denied_kinds" || cmd === "partial_kinds") return [];
    return null;
  }),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));

import { invoke } from "../shared/ipc/tauri";
import { startup } from "./startup";

beforeEach(() => { useAppStore.setState(initialState()); mem.clear(); vi.mocked(invoke).mockClear(); });

describe("startup", () => {
  it("connects nothing when there is no remembered context", async () => {
    await startup();
    expect(useAppStore.getState().contexts).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("connect", expect.anything());
  });

  it("leaves an app without contexts to the welcome pane", async () => {
    vi.mocked(invoke).mockImplementationOnce(async (cmd: string) => (cmd === "list_contexts" ? [] : null));
    await startup();
    expect(useAppStore.getState().contexts).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith("connect", expect.anything());
  });

  it("auto-connects the remembered context and namespace", async () => {
    mem.set("lastContext", "prod");
    mem.set("scope:prod", ["payments"]);
    mem.set("scope:staging", ["default"]); // another context's memory must not leak in
    await startup();
    const s = useAppStore.getState();
    expect(s.connection.context).toBe("prod");
    expect(s.connection.scope).toEqual(["payments"]);
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: ["payments"], expandedGroups: [] });
  });

  it("restores a remembered multi-namespace scope, dropping namespaces that are gone", async () => {
    mem.set("lastContext", "prod");
    mem.set("scope:prod", ["payments", "vanished", "default"]);
    await startup();
    expect(useAppStore.getState().connection.scope).toEqual(["payments", "default"]);
  });

  it("restores All namespaces", async () => {
    mem.set("lastContext", "prod");
    mem.set("scope:prod", "all");
    await startup();
    expect(useAppStore.getState().connection.scope).toBe("all");
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: null, expandedGroups: [] });
  });

  it("does not restore All namespaces without permission to list namespaces", async () => {
    const base = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: any) =>
      (cmd === "connect" ? { context: "prod", serverVersion: "v1", namespaces: ["payments"], canListNamespaces: false } : base(cmd, args)));
    mem.set("lastContext", "prod");
    mem.set("scope:prod", "all");
    try {
      await startup();
    } finally {
      vi.mocked(invoke).mockImplementation(base);
    }
    expect(useAppStore.getState().connection.scope).toEqual(["payments"]);
    expect(invoke).not.toHaveBeenCalledWith("select_namespaces", { namespaces: null, expandedGroups: [] });
    expect(invoke).toHaveBeenCalledWith("select_namespaces", { namespaces: ["payments"], expandedGroups: [] });
  });

  it("falls back to the context's namespace when none of the remembered ones exist", async () => {
    mem.set("lastContext", "prod");
    mem.set("scope:prod", ["vanished"]);
    await startup();
    expect(useAppStore.getState().connection.scope).toEqual(["payments"]);
  });

  it("falls back to the context's default namespace", async () => {
    mem.set("lastContext", "prod");
    mem.set("scope:staging", ["default"]);
    await startup();
    expect(useAppStore.getState().connection.scope).toEqual(["payments"]);
  });

  it("does not connect when the remembered context no longer exists", async () => {
    mem.set("lastContext", "gone");
    await startup();
    expect(invoke).not.toHaveBeenCalledWith("connect", expect.anything());
  });

  it("loads the persisted sidebar-collapsed flag before connecting", async () => {
    mem.set("sidebarCollapsed", true);
    await startup();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });

  it("shows the failure when connecting the remembered context fails", async () => {
    mem.set("lastContext", "prod");
    vi.mocked(invoke).mockImplementationOnce(async (cmd: string) => {
      if (cmd === "list_contexts") return [{ name: "prod", cluster: "c", user: "u", namespace: "payments", sourceFile: "/k" }];
      return null;
    });
    vi.mocked(invoke).mockImplementationOnce(async () => { throw new Error("connect failed"); });
    await startup();
    expect(useAppStore.getState().connection.lastError).toEqual({ context: "prod", error: { kind: "internal", message: "connect failed" } });
    expect(useAppStore.getState().connection.context).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("select_namespaces", expect.anything());
  });
});
