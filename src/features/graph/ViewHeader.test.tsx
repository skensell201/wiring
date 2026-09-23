import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import type { GraphNode, Table } from "../../shared/ipc/types";
import { ViewHeader } from "./ViewHeader";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: "Pod", namespace: "p", name: id.split("/").pop()!, status: "ok", badges: [], group: null, ...over,
});
const row = (name: string): Table["rows"][number] => ({ nodeId: `Pod/p/${name}`, status: "ok", cells: [{ text: name, status: null }] });
const pods: Table = { kind: "Pod", columns: [{ key: "name", label: "Name", numeric: false }], rows: [row("a"), row("b"), row("c")] };

beforeEach(() => useAppStore.setState(initialState()));

describe("ViewHeader", () => {
  it("shows the object count on Overview and disables Table until a kind was opened", () => {
    useAppStore.setState(applySnapshot(initialState(), {
      nodes: [node("Pod/p/a"), node("PodGroup/p/web", { kind: "PodGroup", group: { count: 3, ok: 3, warn: 0, err: 0 } }), node("Deployment/p/web", { kind: "Deployment" })],
      edges: [],
    }));
    render(<ViewHeader />);
    expect(screen.getByText("Overview · 5 objects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Graph" })).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("button", { name: "Table" });
    expect(table).toHaveAttribute("aria-pressed", "false");
    expect(table).toBeDisabled();
  });

  it("reopens the last table kind from Overview", () => {
    const showTable = vi.fn(async () => {});
    useAppStore.setState({ lastTableKind: "Service", showTable });
    render(<ViewHeader />);
    const table = screen.getByRole("button", { name: "Table" });
    expect(table).toBeEnabled();
    fireEvent.click(table);
    expect(showTable).toHaveBeenCalledWith("Service");
  });

  it("shows the breadcrumb of a table view and switches back to the graph", () => {
    const showGraph = vi.fn();
    useAppStore.setState({ view: { name: "table", kind: "Pod" }, tables: new Map([["Pod", pods]]), showGraph });
    render(<ViewHeader />);
    expect(screen.getByText("Workloads / Pods · 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(showGraph).toHaveBeenCalled();
  });

  it("falls back to the graph count while the table is loading", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [node("Pod/p/a"), node("Pod/p/b")], edges: [] }),
      view: { name: "table", kind: "Pod" },
    });
    render(<ViewHeader />);
    expect(screen.getByText("Workloads / Pods · 2")).toBeInTheDocument();
  });
});
