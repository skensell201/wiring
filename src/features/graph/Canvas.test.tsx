import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import { Canvas } from "./Canvas";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));

beforeEach(() => useAppStore.setState(initialState()));

describe("Canvas", () => {
  it("shows the empty state before a namespace is selected", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" } });
    render(<Canvas />);
    expect(screen.getByText(/select a namespace/i)).toBeInTheDocument();
  });

  it("shows the loading state after selecting a namespace until the snapshot arrives", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "payments" } });
    render(<Canvas />);
    expect(screen.getByText(/loading payments/i)).toBeInTheDocument();
  });

  it("shows the empty-namespace state for an empty snapshot", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "payments" },
    });
    render(<Canvas />);
    expect(screen.getByText(/namespace is empty/i)).toBeInTheDocument();
  });

  it("renders nodes from the store", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [{ id: "Pod/p/web-1", kind: "Pod", namespace: "p", name: "web-1", status: "ok", badges: ["Running"], group: null }], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "p" },
    });
    render(<Canvas />);
    expect(screen.getByText("web-1")).toBeInTheDocument();
  });
});
