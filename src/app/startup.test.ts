import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "./store";

const { mem } = vi.hoisted(() => ({ mem: new Map<string, string | null>() }));
vi.mock("../shared/settings", () => ({
  settings: { get: vi.fn(async (k: string) => mem.get(k) ?? null), set: vi.fn(async (k: string, v: string | null) => { mem.set(k, v); }) },
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
    mem.set("lastNamespace", "payments");
    await startup();
    const s = useAppStore.getState();
    expect(s.pickerOpen).toBe(false);
    expect(s.connection.context).toBe("prod");
    expect(s.connection.namespace).toBe("payments");
    expect(invoke).toHaveBeenCalledWith("select_namespace", { namespace: "payments", expandedGroups: [] });
  });

  it("falls back to the context's default namespace", async () => {
    mem.set("lastContext", "prod");
    await startup();
    expect(useAppStore.getState().connection.namespace).toBe("payments");
  });

  it("opens the picker when the remembered context no longer exists", async () => {
    mem.set("lastContext", "gone");
    await startup();
    expect(useAppStore.getState().pickerOpen).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("connect", expect.anything());
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
