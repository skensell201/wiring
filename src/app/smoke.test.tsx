import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";

vi.mock("../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));
vi.mock("../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastNamespace: vi.fn(async () => null), setLastNamespace: vi.fn(async () => {}) },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

describe("App shell", () => {
  it("renders", () => {
    render(<App />);
    expect(screen.getByText("Wiring")).toBeInTheDocument();
    expect(screen.getByText(/connect to a cluster/i)).toBeInTheDocument();
  });
});
