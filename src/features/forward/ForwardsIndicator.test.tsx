import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

import { initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import type { Forward } from "../../shared/ipc/types";
import { ForwardsIndicator } from "./ForwardsIndicator";

const a: Forward = { id: 1, nodeId: "Service/p/web", targetLabel: "Service web", remotePort: 80, localPort: 8080, pod: "web-1", status: "active", message: null };
const b: Forward = { id: 2, nodeId: "Pod/p/db-0", targetLabel: "Pod db-0", remotePort: 5432, localPort: 5432, pod: null, status: "error", message: "forbidden" };
const writeText = vi.fn(async () => {});

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockClear();
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

describe("ForwardsIndicator", () => {
  it("is hidden without forwards", () => {
    render(<ForwardsIndicator />);
    expect(screen.queryByRole("button", { name: "Port forwards" })).not.toBeInTheDocument();
  });

  it("counts the forwards and lists them with their status", () => {
    useAppStore.setState({ forwards: [a, b] });
    render(<ForwardsIndicator />);
    const button = screen.getByRole("button", { name: "Port forwards" });
    expect(button).toHaveTextContent("2");
    fireEvent.click(button);
    expect(useAppStore.getState().forwardsOpen).toBe(true);
    expect(screen.getByText("localhost:8080")).toBeInTheDocument();
    expect(screen.getByText("active · web-1")).toBeInTheDocument();
    expect(screen.getByText("error: forbidden")).toBeInTheDocument();
  });

  it("Open, Copy and Stop act on their forward", () => {
    useAppStore.setState({ forwards: [a], forwardsOpen: true });
    render(<ForwardsIndicator />);
    fireEvent.click(screen.getByRole("button", { name: "Open localhost:8080" }));
    expect(invoke).toHaveBeenCalledWith("open_forward", { id: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Copy localhost:8080" }));
    expect(writeText).toHaveBeenCalledWith("http://localhost:8080");
    fireEvent.click(screen.getByRole("button", { name: "Stop localhost:8080" }));
    expect(invoke).toHaveBeenCalledWith("stop_forward", { id: 1 });
  });

  it("a click outside closes the popover", () => {
    useAppStore.setState({ forwards: [a], forwardsOpen: true });
    render(<ForwardsIndicator />);
    fireEvent.mouseDown(screen.getByTestId("forwards-backdrop"));
    expect(useAppStore.getState().forwardsOpen).toBe(false);
  });
});
