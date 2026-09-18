import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import { DetailsPanel } from "./DetailsPanel";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));
vi.mock("./yaml", () => ({ highlightYaml: vi.fn(async (src: string) => `<pre class="shiki"><code>${src}</code></pre>`) }));

const node = { id: "Pod/p/web-1", kind: "Pod" as const, namespace: "p", name: "web-1", status: "ok" as const, badges: [], group: null };

beforeEach(() => {
  useAppStore.setState(
    {
      ...applySnapshot(initialState(), { nodes: [node, { ...node, id: "Service/p/web", kind: "Service", name: "web" }], edges: [] }),
      selectedId: "Pod/p/web-1",
      details: {
        nodeId: "Pod/p/web-1", loading: false,
        data: { yaml: "kind: Pod\nmetadata:\n  name: web-1\n", summary: [["Phase", "Running"], ["Node", "worker-3"]], related: ["Service/p/web"] },
        events: [{ name: "e1", type: "Warning", reason: "BackOff", message: "restarting", count: 3, firstTimestamp: null, lastTimestamp: "2026-09-17T10:00:00Z" }],
      },
    },
  );
});

describe("DetailsPanel", () => {
  it("shows the overview rows and related nodes; clicking a related node selects it", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ select });
    render(<DetailsPanel />);
    expect(screen.getByText("Phase")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Service.*web/ }));
    expect(select).toHaveBeenCalledWith("Service/p/web");
  });

  it("switches to the YAML tab and renders highlighted YAML", async () => {
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    expect(await screen.findByText(/kind: Pod/)).toBeInTheDocument();
  });

  it("lists events with Warning styling", () => {
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    const row = screen.getByText("BackOff").closest("tr")!;
    expect(row).toHaveAttribute("data-type", "Warning");
    expect(screen.getByText("restarting")).toBeInTheDocument();
  });

  it("names a selected object that is not a graph node from its id", () => {
    // Rows of pods collapsed into a PodGroup are selectable from the table but never in `nodes`.
    useAppStore.setState({ selectedId: "Pod/p/web-9", details: { nodeId: "Pod/p/web-9", data: null, events: [], loading: true } });
    render(<DetailsPanel />);
    expect(screen.getByText("web-9")).toBeInTheDocument();
    expect(screen.getByText("Pod · p")).toBeInTheDocument();
  });

  it("names a cluster-scoped object that is not a graph node without a namespace", () => {
    useAppStore.setState({ selectedId: "PersistentVolume/pv-1", details: { nodeId: "PersistentVolume/pv-1", data: null, events: [], loading: true } });
    render(<DetailsPanel />);
    expect(screen.getByText("pv-1")).toBeInTheDocument();
    expect(screen.getByText("PersistentVolume")).toBeInTheDocument();
  });

  it("shows a hint when nothing is selected", () => {
    useAppStore.setState({ selectedId: null, details: null });
    render(<DetailsPanel />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });
});
