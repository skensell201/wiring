import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import type { KubeconfigSource } from "../../shared/ipc/types";

// Linux has no OS installer, so the first run inside the app carries the brand.
vi.mock("../../shared/platform", () => ({ isMac: false, isLinux: true }));
vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/team.yaml") }));
vi.mock("../../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
}));

import { invoke } from "../../shared/ipc/tauri";
import { ConnectionPane } from "./ConnectionPane";

const SOURCES: KubeconfigSource[] = [{ path: "/home/me/.kube/config", origin: "default", state: "ok", contexts: 2, error: null }];

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "kubeconfig_sources" ? SOURCES : []));
});

describe("the Linux first run", () => {
  it("greets with the brand and one line of what Wiring is", async () => {
    render(<ConnectionPane pane={{ type: "welcome" }} />);
    expect(screen.getByRole("heading", { name: "Wiring" })).toBeInTheDocument();
    expect(screen.getByText(/shows how your namespace is wired together/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Kubeconfig files")).toBeInTheDocument());
  });

  it("offers the way in", () => {
    render(<ConnectionPane pane={{ type: "welcome" }} />);
    expect(screen.getByRole("button", { name: "Add kubeconfig…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rescan" })).toBeInTheDocument();
  });
});
