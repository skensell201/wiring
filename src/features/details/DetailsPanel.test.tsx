import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore, viewEditor } from "../../app/store";
import { DetailsPanel } from "./DetailsPanel";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("./yaml", () => ({ highlightYaml: vi.fn(async (src: string) => `<pre class="shiki"><code>${src}</code></pre>`) }));

const node = { id: "Pod/p/web-1", kind: "Pod" as const, namespace: "p", name: "web-1", status: "ok" as const, badges: [], group: null };

beforeEach(() => {
  useAppStore.setState(
    {
      ...applySnapshot(initialState(), { nodes: [node, { ...node, id: "Service/p/web", kind: "Service", name: "web" }], edges: [] }),
      selectedId: "Pod/p/web-1",
      details: {
        nodeId: "Pod/p/web-1", loading: false, editor: viewEditor("kind: Pod\nmetadata:\n  name: web-1\n"),
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
    useAppStore.setState({ selectedId: "Pod/p/web-9", details: { nodeId: "Pod/p/web-9", data: null, events: [], loading: true, editor: viewEditor() } });
    render(<DetailsPanel />);
    expect(screen.getByText("web-9")).toBeInTheDocument();
    expect(screen.getByText("Pod · p")).toBeInTheDocument();
  });

  it("names a cluster-scoped object that is not a graph node without a namespace", () => {
    useAppStore.setState({ selectedId: "PersistentVolume/pv-1", details: { nodeId: "PersistentVolume/pv-1", data: null, events: [], loading: true, editor: viewEditor() } });
    render(<DetailsPanel />);
    expect(screen.getByText("pv-1")).toBeInTheDocument();
    expect(screen.getByText("PersistentVolume")).toBeInTheDocument();
  });

  it("shows a hint when nothing is selected", () => {
    useAppStore.setState({ selectedId: null, details: null });
    render(<DetailsPanel />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("DetailsPanel delete", () => {
  it("the trash button asks before deleting a Pod; confirming deletes", () => {
    const confirmDelete = vi.fn(async () => {});
    useAppStore.setState({ confirmDelete });
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Pod web-1?" });
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(useAppStore.getState().deleteDialog).toEqual({ open: true, nodeId: "Pod/p/web-1" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(confirmDelete).toHaveBeenCalled();
  });

  it("Cancel closes the dialog without deleting", () => {
    const confirmDelete = vi.fn(async () => {});
    useAppStore.setState({ confirmDelete });
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(useAppStore.getState().deleteDialog.open).toBe(false);
    expect(confirmDelete).not.toHaveBeenCalled();
  });

  it("words a PodGroup as its member count and says the controller recreates them", () => {
    const group = { id: "PodGroup/p/Deployment/web", kind: "PodGroup" as const, namespace: "p", name: "web", status: "ok" as const, badges: [], group: { count: 7, ok: 7, warn: 0, err: 0 } };
    useAppStore.setState((s) => ({
      nodes: new Map([...s.nodes, [group.id, group]]), selectedId: group.id,
      details: { nodeId: group.id, data: { yaml: "", summary: [], related: [] }, events: [], loading: false, editor: viewEditor() },
    }));
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete 7 pods of Deployment web?" });
    expect(dialog).toHaveTextContent(/controller will recreate them/i);
  });
});

describe("DetailsPanel discard", () => {
  it("asks to discard dirty edits; Discard confirms, Cancel keeps them", () => {
    const confirmDiscard = vi.fn(), cancelDiscard = vi.fn();
    useAppStore.setState({ confirmDiscard, cancelDiscard, discardDialog: { ...initialState().discardDialog, open: true, pendingSelect: "Service/p/web" } });
    render(<DetailsPanel />);
    const dialog = screen.getByRole("alertdialog", { name: "Discard your edits?" });
    expect(dialog).toHaveTextContent(/web-1/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(confirmDiscard).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(cancelDiscard).toHaveBeenCalled();
  });
});
