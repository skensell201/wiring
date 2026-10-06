import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore, viewEditor } from "../../app/store";
import { settings } from "../../shared/settings";
import { DetailsPanel, headingFromId } from "./DetailsPanel";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("../../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
}));
vi.mock("../exec/TerminalTab", () => ({ TerminalTab: () => <div>terminal</div> }));
vi.mock("./yaml", () => ({ highlightYaml: vi.fn(async (src: string) => `<pre class="shiki"><code>${src}</code></pre>`) }));

const node = { id: "Pod/p/web-1", kind: "Pod" as const, namespace: "p", name: "web-1", status: "ok" as const, badges: [], group: null };

beforeEach(() => {
  vi.mocked(settings.getDetailsHeight).mockReset().mockResolvedValue(null);
  vi.mocked(settings.setDetailsHeight).mockClear();
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

  it("offers a Logs tab for pods and workloads only", () => {
    const logsTab = () => screen.queryByRole("tab", { name: "Logs" });
    // A Pod that is a graph node (the default fixture).
    const { unmount } = render(<DetailsPanel />);
    expect(logsTab()).toBeInTheDocument();
    unmount();
    // A ConfigMap: nothing to stream.
    const cm = { ...node, id: "ConfigMap/p/cfg", kind: "ConfigMap" as const, name: "cfg" };
    useAppStore.setState((s) => ({ nodes: new Map([...s.nodes, [cm.id, cm]]), selectedId: cm.id, details: { ...s.details!, nodeId: cm.id } }));
    const r2 = render(<DetailsPanel />);
    expect(logsTab()).not.toBeInTheDocument();
    r2.unmount();
    // A PodGroup: the merged logs of its members.
    const group = { ...node, id: "PodGroup/p/Deployment/web", kind: "PodGroup" as const, name: "web", group: { count: 2, ok: 2, warn: 0, err: 0 } };
    useAppStore.setState((s) => ({ nodes: new Map([...s.nodes, [group.id, group]]), selectedId: group.id, details: { ...s.details!, nodeId: group.id } }));
    const r3 = render(<DetailsPanel />);
    expect(logsTab()).toBeInTheDocument();
    r3.unmount();
    // A pod collapsed into a group is selectable from the table but never in `nodes`: the kind comes from the id.
    useAppStore.setState((s) => ({ selectedId: "Pod/p/web-9", details: { ...s.details!, nodeId: "Pod/p/web-9" } }));
    render(<DetailsPanel />);
    expect(logsTab()).toBeInTheDocument();
  });

  it("offers a Terminal tab for pods and pod-running workloads only", () => {
    const termTab = () => screen.queryByRole("tab", { name: "Terminal" });
    const select = (id: string, kind: string) => {
      const n = { ...node, id, kind: kind as typeof node.kind, name: id.split("/").pop()! };
      useAppStore.setState((s) => ({ nodes: new Map([...s.nodes, [n.id, n]]), selectedId: n.id, details: { ...s.details!, nodeId: n.id } }));
    };
    for (const kind of ["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "PodGroup", "Service", "CronJob", "ConfigMap"]) {
      select(`${kind}/p/x`, kind);
      const { unmount } = render(<DetailsPanel />);
      if (["Service", "CronJob", "ConfigMap"].includes(kind)) expect(termTab(), kind).not.toBeInTheDocument();
      else expect(termTab(), kind).toBeInTheDocument();
      unmount();
    }
    select("Deployment/p/x", "Deployment");
    render(<DetailsPanel />);
    fireEvent.click(termTab()!);
    expect(screen.getByText("terminal")).toBeInTheDocument();
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

describe("DetailsPanel height", () => {
  const separator = () => screen.getByRole("separator");
  const heightOf = (el: HTMLElement) => Number(el.getAttribute("aria-valuenow"));

  it("loads the saved height, steps it with the arrow keys, clamps to the window and saves the result", async () => {
    vi.mocked(settings.getDetailsHeight).mockResolvedValueOnce(400);
    render(<DetailsPanel />);
    await waitFor(() => expect(separator()).toHaveAttribute("aria-valuenow", "400"));
    const sep = separator();
    expect(sep).toHaveAttribute("aria-orientation", "horizontal");
    expect(sep).toHaveAttribute("aria-valuemin", "200");
    expect(sep).toHaveAttribute("aria-valuemax", String(window.innerHeight - 200));
    expect(sep).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(sep, { key: "ArrowUp" }); // +16
    expect(sep).toHaveAttribute("aria-valuenow", "416");
    expect(settings.setDetailsHeight).toHaveBeenLastCalledWith(416);
    fireEvent.keyDown(sep, { key: "ArrowDown", shiftKey: true }); // -64
    expect(sep).toHaveAttribute("aria-valuenow", "352");
    expect(settings.setDetailsHeight).toHaveBeenLastCalledWith(352);
    // Never taller than the window minus 200 ...
    for (let i = 0; i < 100; i++) fireEvent.keyDown(sep, { key: "ArrowUp", shiftKey: true });
    expect(heightOf(sep)).toBe(window.innerHeight - 200);
    // ... and never shorter than 200.
    for (let i = 0; i < 100; i++) fireEvent.keyDown(sep, { key: "ArrowDown", shiftKey: true });
    expect(heightOf(sep)).toBe(200);
    expect(settings.setDetailsHeight).toHaveBeenLastCalledWith(200);
  });

  it("clamps a saved height that no longer fits the window", async () => {
    vi.mocked(settings.getDetailsHeight).mockResolvedValueOnce(99_999);
    render(<DetailsPanel />);
    await waitFor(() => expect(heightOf(separator())).toBe(window.innerHeight - 200));
    // Loading never counts as a change worth saving.
    expect(settings.setDetailsHeight).not.toHaveBeenCalled();
  });

  it("drags the separator and saves the height on pointer-up", async () => {
    vi.mocked(settings.getDetailsHeight).mockResolvedValueOnce(300);
    render(<DetailsPanel />);
    await waitFor(() => expect(separator()).toHaveAttribute("aria-valuenow", "300"));
    const sep = separator();
    sep.setPointerCapture = vi.fn();
    // A click without movement is not a resize: nothing to save.
    fireEvent.pointerDown(sep, { clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientY: 500, pointerId: 1 });
    expect(settings.setDetailsHeight).not.toHaveBeenCalled();
    fireEvent.pointerDown(sep, { clientY: 500, pointerId: 1 });
    expect(sep.setPointerCapture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(sep, { clientY: 450, pointerId: 1 }); // dragged up 50px: taller
    expect(sep).toHaveAttribute("aria-valuenow", "350");
    expect(settings.setDetailsHeight).not.toHaveBeenCalled();
    fireEvent.pointerUp(sep, { clientY: 450, pointerId: 1 });
    expect(settings.setDetailsHeight).toHaveBeenCalledTimes(1);
    expect(settings.setDetailsHeight).toHaveBeenLastCalledWith(350);
    // After the release the pointer is no longer tracked.
    fireEvent.pointerMove(sep, { clientY: 100, pointerId: 1 });
    expect(sep).toHaveAttribute("aria-valuenow", "350");
  });

  it("re-clamps the height when the window shrinks, without saving", async () => {
    const original = window.innerHeight;
    vi.mocked(settings.getDetailsHeight).mockResolvedValueOnce(original - 200);
    render(<DetailsPanel />);
    await waitFor(() => expect(heightOf(separator())).toBe(original - 200));
    try {
      Object.defineProperty(window, "innerHeight", { value: original - 100, configurable: true, writable: true });
      fireEvent(window, new Event("resize"));
      expect(heightOf(separator())).toBe(original - 300);
      expect(separator()).toHaveAttribute("aria-valuemax", String(original - 300));
      expect(settings.setDetailsHeight).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "innerHeight", { value: original, configurable: true, writable: true });
    }
  });
});

describe("DetailsPanel maximise", () => {
  it("the maximise button toggles detailsMaximized and hides the separator while maximised", () => {
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));
    expect(useAppStore.getState().detailsMaximized).toBe(true);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore panel" }));
    expect(useAppStore.getState().detailsMaximized).toBe(false);
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize panel" })).toBeInTheDocument();
  });

  it("has no collapse toggle any more", () => {
    render(<DetailsPanel />);
    expect(screen.queryByTitle(/collapse panel/i)).not.toBeInTheDocument();
    expect(screen.queryByText("▾")).not.toBeInTheDocument();
  });

  it("the Actions button opens the menu for the selection", () => {
    const dep = { ...node, id: "Deployment/p/web", kind: "Deployment" as const, name: "web" };
    useAppStore.setState((s) => ({ nodes: new Map([...s.nodes, [dep.id, dep]]), selectedId: dep.id, details: { ...s.details!, nodeId: dep.id } }));
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(useAppStore.getState().actionsMenu).toMatchObject({ nodeId: "Deployment/p/web" });
  });

  it("has no Actions button when delete is the only action (the trash button covers it)", () => {
    const cm = { ...node, id: "ConfigMap/p/cfg", kind: "ConfigMap" as const, name: "cfg" };
    useAppStore.setState((s) => ({ nodes: new Map([...s.nodes, [cm.id, cm]]), selectedId: cm.id, details: { ...s.details!, nodeId: cm.id } }));
    render(<DetailsPanel />);
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("offers a History tab for rollout kinds only, and opens it on request", () => {
    const historyTab = () => screen.queryByRole("tab", { name: "History" });
    const { unmount } = render(<DetailsPanel />);
    expect(historyTab()).not.toBeInTheDocument(); // a Pod
    unmount();
    const dep = { ...node, id: "Deployment/p/web", kind: "Deployment" as const, name: "web" };
    useAppStore.setState((s) => ({ nodes: new Map([...s.nodes, [dep.id, dep]]), selectedId: dep.id, details: { ...s.details!, nodeId: dep.id }, requestedTab: "history" }));
    render(<DetailsPanel />);
    expect(historyTab()).toHaveAttribute("aria-selected", "true");
    expect(useAppStore.getState().requestedTab).toBeNull();
  });
});

describe("headingFromId for a custom resource", () => {
  it("takes the namespace and name from the id, not the group", () => {
    expect(headingFromId("Custom/cert-manager.io/v1/Certificate/shop/web-tls")).toEqual({ name: "web-tls", kind: "Custom", namespace: "shop" });
    expect(headingFromId("Custom/cert-manager.io/v1/ClusterIssuer//le")).toEqual({ name: "le", kind: "Custom", namespace: null });
  });
});

describe("DetailsPanel for a custom resource", () => {
  it("shows the real kind in the related list and heading", () => {
    const cr = { ...node, id: "Custom/cert-manager.io/v1/Certificate/shop/web-tls", kind: "Custom" as const, namespace: "shop", name: "web-tls" };
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [cr, node], edges: [] }),
      selectedId: "Pod/p/web-1",
      details: {
        nodeId: "Pod/p/web-1", loading: false, editor: viewEditor("kind: Pod\n"),
        data: { yaml: "kind: Pod\n", summary: [], related: ["Custom/cert-manager.io/v1/Certificate/shop/web-tls"] }, events: [],
      },
    });
    render(<DetailsPanel />);
    expect(screen.getByRole("button", { name: /Certificate.*web-tls/ })).toBeInTheDocument();
  });

  it("a selected custom resource has Overview, YAML and Events and Delete, but no workload tabs or Actions", () => {
    const id = "Custom/cert-manager.io/v1/Certificate/shop/web-tls";
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [], edges: [] }),
      selectedId: id,
      details: { nodeId: id, loading: false, editor: viewEditor("kind: Certificate\n"), data: { yaml: "kind: Certificate\n", summary: [["Ready", "True"]], related: [] }, events: [] },
    });
    render(<DetailsPanel />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "YAML", "Events"]);
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByText("Certificate · shop")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });
});
