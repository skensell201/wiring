import { beforeEach, describe, expect, it, vi } from "vitest";

const { mem } = vi.hoisted(() => ({ mem: new Map<string, unknown>() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async (k: string) => mem.get(k)),
    set: vi.fn(async (k: string, v: unknown) => { mem.set(k, v); }),
  })),
}));

import { settings } from "./settings";

beforeEach(() => mem.clear());

describe("settings", () => {
  it("remembers the last namespace per context", async () => {
    await settings.setLastNamespace("prod", "payments");
    await settings.setLastNamespace("staging", "default");
    expect(await settings.getLastNamespace("prod")).toBe("payments");
    expect(await settings.getLastNamespace("staging")).toBe("default");
    expect(await settings.getLastNamespace("dev")).toBeNull();
    expect(mem.get("lastNamespace")).toEqual({ prod: "payments", staging: "default" });
  });

  it("ignores a legacy single-string value", async () => {
    mem.set("lastNamespace", "payments");
    expect(await settings.getLastNamespace("prod")).toBeNull();
    await settings.setLastNamespace("prod", "shop");
    expect(mem.get("lastNamespace")).toEqual({ prod: "shop" });
  });

  it("remembers the last scope per context", async () => {
    await settings.setLastScope("ctx", ["a", "b"]);
    expect(await settings.getLastScope("ctx")).toEqual(["a", "b"]);
    await settings.setLastScope("ctx", "all");
    expect(await settings.getLastScope("ctx")).toBe("all");
    expect(await settings.getLastScope("other")).toBeNull();
  });

  it("reads a legacy lastNamespace as a one-namespace scope", async () => {
    mem.set("lastNamespace", { ctx: "shop" });
    expect(await settings.getLastScope("ctx")).toEqual(["shop"]);
  });

  it("falls back to the legacy value or null on a garbage scope", async () => {
    mem.set("lastScope", { ctx: 42 });
    expect(await settings.getLastScope("ctx")).toBeNull();
    mem.set("lastNamespace", { ctx: "shop" });
    expect(await settings.getLastScope("ctx")).toEqual(["shop"]);
    mem.set("lastScope", { ctx: [] });
    mem.delete("lastNamespace");
    expect(await settings.getLastScope("ctx")).toBeNull();
  });

  it("stores the last context", async () => {
    await settings.set("lastContext", "prod");
    expect(await settings.get<string>("lastContext")).toBe("prod");
  });

  it("defaults sidebarCollapsed to false and remembers it once set", async () => {
    expect(await settings.getSidebarCollapsed()).toBe(false);
    await settings.setSidebarCollapsed(true);
    expect(await settings.getSidebarCollapsed()).toBe(true);
    expect(mem.get("sidebarCollapsed")).toBe(true);
  });

  it("defaults detailsHeight to null, remembers a number and ignores garbage", async () => {
    expect(await settings.getDetailsHeight()).toBeNull();
    await settings.setDetailsHeight(400);
    expect(await settings.getDetailsHeight()).toBe(400);
    expect(mem.get("detailsHeight")).toBe(400);
    mem.set("detailsHeight", "tall");
    expect(await settings.getDetailsHeight()).toBeNull();
    mem.set("detailsHeight", Number.NaN);
    expect(await settings.getDetailsHeight()).toBeNull();
  });
});
