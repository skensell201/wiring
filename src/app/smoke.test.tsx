import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";

vi.mock("../shared/ipc/tauri", () => ({ invoke: vi.fn(async (cmd: string) => (cmd === "list_contexts" ? [] : null)), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

describe("App shell", () => {
  it("renders", () => {
    render(<App />);
    expect(screen.getByText("Wiring")).toBeInTheDocument();
    // No contexts and no session: the welcome pane stands in for the views.
    expect(screen.getByRole("status", { name: "Connect Wiring to a cluster" })).toBeInTheDocument();
  });
});
