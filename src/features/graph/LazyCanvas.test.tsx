import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { LazyCanvas } from "./LazyCanvas";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

beforeEach(() => useAppStore.setState(initialState()));

describe("LazyCanvas", () => {
  it("shows a placeholder and then the real canvas once the chunk has loaded", async () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["payments"] } });
    render(<LazyCanvas />);
    // The chunk is still loading on the first paint.
    expect(screen.getByText("Loading graph…")).toBeInTheDocument();
    // ... and the canvas takes over once it arrives.
    expect(await screen.findByText(/loading payments/i)).toBeInTheDocument();
    expect(screen.queryByText("Loading graph…")).not.toBeInTheDocument();
  });
});
