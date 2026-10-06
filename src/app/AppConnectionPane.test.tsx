import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { initialState, useAppStore } from "./store";

const hoisted = vi.hoisted(() => ({ resolveConnect: null as ((v: unknown) => void) | null }));
vi.mock("./startup", () => ({ startup: vi.fn(async () => {}) }));
vi.mock("./wireEvents", () => ({ wireEvents: vi.fn(async () => () => {}) }));
vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "connect") return new Promise((r) => { hoisted.resolveConnect = r; });
    if (cmd === "list_contexts" || cmd === "kubeconfig_sources" || cmd === "denied_kinds" || cmd === "partial_kinds") return [];
    return null;
  }),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));
vi.mock("../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

import { invoke } from "../shared/ipc/tauri";

const detailsPanel = () => screen.queryByRole("separator", { name: "Resize details panel" });

beforeEach(() => {
  hoisted.resolveConnect = null;
  vi.mocked(invoke).mockClear();
  useAppStore.setState(initialState());
});

describe("App with a connection pane", () => {
  it("shows neither the welcome nor the choose pane before the contexts are loaded", async () => {
    render(<App />);
    await act(async () => {});
    expect(screen.queryByRole("status", { name: "Connect Wiring to a cluster" })).toBeNull();
    expect(screen.queryByRole("status", { name: "Choose a cluster" })).toBeNull();
    expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).not.toContain("kubeconfig_sources");
  });

  it("hides the old cluster's details panel while switching, and brings it back after", async () => {
    useAppStore.setState({
      contexts: [
        { name: "a", cluster: "c", user: "u", namespace: null, sourceFile: "/k" },
        { name: "b", cluster: "c", user: "u", namespace: null, sourceFile: "/k" },
      ],
      connection: { ...initialState().connection, state: "connected", context: "a", serverVersion: "v1", namespaces: ["shop"], canListNamespaces: true },
      selectedId: "shop/Pod/web",
    });
    render(<App />);
    expect(detailsPanel()).toBeInTheDocument();

    let done!: Promise<boolean>;
    act(() => { done = useAppStore.getState().connect("b"); });
    expect(await screen.findByRole("status", { name: "Connecting to b…" })).toBeInTheDocument();
    expect(detailsPanel()).toBeNull();

    await act(async () => {
      hoisted.resolveConnect?.({ context: "b", serverVersion: "v1", namespaces: ["shop"], canListNamespaces: true });
      await done;
    });
    await waitFor(() => expect(detailsPanel()).toBeInTheDocument());
    expect(useAppStore.getState().selectedId).toBeNull();
  });
});
