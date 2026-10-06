import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { Toasts } from "./Toasts";

vi.mock("../ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

beforeEach(() => useAppStore.setState(initialState()));

describe("Toasts", () => {
  it("titles error toasts in words, and info toasts not at all", () => {
    useAppStore.setState({
      toasts: [
        { id: 1, kind: "network", message: "connection refused" },
        { id: 2, kind: "forbidden", message: "pods is forbidden" },
        { id: 3, kind: "internal", message: "boom" },
        { id: 4, kind: "info", message: "Added team.yaml: 2 contexts" },
      ],
    });
    render(<Toasts />);
    expect(screen.getByText("Network error")).toBeInTheDocument();
    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Added team.yaml: 2 contexts")).toBeInTheDocument();
    expect(screen.queryByText("network")).toBeNull();
    expect(screen.queryByText("info")).toBeNull();
  });

  it("announces info toasts politely and errors assertively", () => {
    useAppStore.setState({
      toasts: [
        { id: 1, kind: "network", message: "connection refused" },
        { id: 2, kind: "info", message: "Saved" },
      ],
    });
    render(<Toasts />);
    expect(screen.getByRole("alert")).toHaveTextContent("connection refused");
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });
});
