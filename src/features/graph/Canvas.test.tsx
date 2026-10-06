import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import { Canvas } from "./Canvas";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

beforeEach(() => useAppStore.setState(initialState()));

describe("Canvas", () => {
  it("shows the empty state before a namespace is selected", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" } });
    render(<Canvas />);
    expect(screen.getByText(/select a namespace/i)).toBeInTheDocument();
  });

  it("shows the loading state after selecting a namespace until the snapshot arrives", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["payments"] } });
    render(<Canvas />);
    expect(screen.getByText(/loading payments/i)).toBeInTheDocument();
  });

  it("shows the empty-namespace state for an empty snapshot", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["payments"] },
    });
    render(<Canvas />);
    expect(screen.getByText(/namespace is empty/i)).toBeInTheDocument();
  });

  it("consumes a focus request once it has centred on the node", async () => {
    // A request left in the store would replay on the next mount (e.g. after a table round-trip)
    // and fight the whole-graph fit; the canvas clears it after its settling pass.
    const base = applySnapshot(initialState(), { nodes: [{ id: "Pod/p/web-1", kind: "Pod", namespace: "p", name: "web-1", status: "ok", badges: ["Running"], group: null }], edges: [] });
    useAppStore.setState({
      ...base, connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["p"] },
      selectedId: "Pod/p/web-1", focusRequest: { nodeId: "Pod/p/web-1", seq: 1 },
    });
    render(<Canvas />);
    expect(screen.getByText("web-1")).toBeInTheDocument();
    await waitFor(() => expect(useAppStore.getState().focusRequest).toBeNull());
    // A later request is honoured the same way.
    act(() => useAppStore.setState({ focusRequest: { nodeId: "Pod/p/web-1", seq: 2 } }));
    await waitFor(() => expect(useAppStore.getState().focusRequest).toBeNull());
  });

  it("renders nodes from the store", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [{ id: "Pod/p/web-1", kind: "Pod", namespace: "p", name: "web-1", status: "ok", badges: ["Running"], group: null }], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["p"] },
    });
    render(<Canvas />);
    expect(screen.getByText("web-1")).toBeInTheDocument();
  });

  it("right-clicking a node opens the Actions menu for it", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [{ id: "Deployment/p/web", kind: "Deployment", namespace: "p", name: "web", status: "ok", badges: ["1/1"], group: null }], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["p"] },
    });
    render(<Canvas />);
    fireEvent.contextMenu(screen.getByText("web"), { clientX: 120, clientY: 80 });
    expect(useAppStore.getState().actionsMenu).toEqual({ nodeId: "Deployment/p/web", x: 120, y: 80 });
  });

  it("frames each namespace in a lane and keeps nodes clickable through it", () => {
    const node = (id: string, kind: "Deployment" | "Pod", ns: string) => ({ id, kind, namespace: ns, name: id.split("/").pop()!, status: "ok" as const, badges: [], group: null });
    useAppStore.setState({
      ...applySnapshot(initialState(), {
        nodes: [node("Deployment/shop/web", "Deployment", "shop"), node("Pod/shop/web-1", "Pod", "shop"), node("Deployment/blog/api", "Deployment", "blog")],
        edges: [],
      }),
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop", "blog"] },
    });
    render(<Canvas />);
    expect(screen.getByText("blog")).toBeInTheDocument();
    expect(screen.getByText("1 object")).toBeInTheDocument();
    expect(screen.getByText("shop")).toBeInTheDocument();
    expect(screen.getByText("2 objects")).toBeInTheDocument();
    for (const id of ["lane:shop", "lane:blog"]) {
      const frame = screen.getByTestId(`rf__node-${id}`);
      expect(frame.style.pointerEvents).toBe("none");
      expect(frame.classList.contains("selectable")).toBe(false);
      expect(frame.classList.contains("draggable")).toBe(false);
    }

    fireEvent.click(screen.getByText("api"));
    expect(useAppStore.getState().selectedId).toBe("Deployment/blog/api");
    fireEvent.contextMenu(screen.getByText("web-1"), { clientX: 10, clientY: 20 });
    expect(useAppStore.getState().actionsMenu).toEqual({ nodeId: "Pod/shop/web-1", x: 10, y: 20 });
  });

  it("says when the selection is too large for the graph", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [], edges: [] }),
      tooLarge: { nodes: 1873, kinds: [] },
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: "all" },
    });
    render(<Canvas />);
    expect(screen.getByText("1,873 objects — too many for the graph. Use the tables, or pick fewer namespaces.")).toBeInTheDocument();
  });
});
