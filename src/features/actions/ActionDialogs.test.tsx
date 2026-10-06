import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import type { GraphEdge, GraphNode } from "../../shared/ipc/types";
import { ActionDialogs } from "./ActionDialogs";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const WEB = "Deployment/p/web";
const web: GraphNode = { id: WEB, kind: "Deployment", namespace: "p", name: "web", status: "ok", badges: ["3/3", "nginx:1.27"], group: null };
const hpa: GraphNode = { id: "HorizontalPodAutoscaler/p/web-hpa", kind: "HorizontalPodAutoscaler", namespace: "p", name: "web-hpa", status: "ok", badges: ["2–10", "3"], group: null };
const scales: GraphEdge = { id: "e", source: hpa.id, target: WEB, relation: "scales" };

beforeEach(() => useAppStore.setState(applySnapshot(initialState(), { nodes: [web], edges: [] })));

describe("ScaleDialog", () => {
  it("starts from the desired replicas and applies the new count", () => {
    const scaleObject = vi.fn(async () => {});
    useAppStore.setState({ scaleObject, actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    const dialog = screen.getByRole("dialog", { name: "Scale Deployment web" });
    const input = within(dialog).getByRole("spinbutton", { name: "Replicas" });
    expect(input).toHaveValue(3);
    fireEvent.click(within(dialog).getByRole("button", { name: "Increase replicas" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Increase replicas" }));
    expect(input).toHaveValue(5);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(scaleObject).toHaveBeenCalledWith(WEB, 5);
  });

  it("leaves the count empty and says replicas and HPA are unknown while the graph is too large", () => {
    const scaleObject = vi.fn(async () => {});
    const tooLarge = { nodes: 1873, kinds: [{ kind: "Deployment" as const, count: 120, worst: "ok" as const }] };
    useAppStore.setState({ ...applySnapshot(initialState(), { nodes: [], edges: [], tooLarge }), tooLarge, scaleObject, actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    const input = screen.getByRole("spinbutton", { name: "Replicas" });
    expect(input).toHaveValue(null);
    expect(input).toBeRequired();
    expect(screen.getByRole("note")).toHaveTextContent("Current replicas and HPA unknown while the graph is too large");
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(scaleObject).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "4" } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(scaleObject).toHaveBeenCalledWith(WEB, 4);
  });

  it("says replicas and HPA are unknown when the workload is simply not in the graph", () => {
    useAppStore.setState({ actionDialog: { type: "scale", nodeId: "Deployment/p/other" } });
    render(<ActionDialogs />);
    expect(screen.getByRole("spinbutton", { name: "Replicas" })).toHaveValue(null);
    expect(screen.getByRole("note")).toHaveTextContent("Current replicas and HPA unknown");
    expect(screen.getByRole("note")).not.toHaveTextContent("too large");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("refuses counts outside 0 … 10000", () => {
    useAppStore.setState({ actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    const input = screen.getByRole("spinbutton", { name: "Replicas" });
    for (const bad of ["-1", "10001", "1.5", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("warns when an HPA manages the workload but still allows the scale", () => {
    useAppStore.setState({ ...applySnapshot(initialState(), { nodes: [web, hpa], edges: [scales] }), actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    expect(screen.getByRole("note")).toHaveTextContent("Managed by HPA web-hpa (min 2, max 10) — it will override this value.");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("disables Apply while an action is running", () => {
    useAppStore.setState({ actionBusy: true, actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    useAppStore.setState({ actionBusy: false });
  });

  it("Cancel closes without scaling", () => {
    const scaleObject = vi.fn(async () => {});
    useAppStore.setState({ scaleObject, actionDialog: { type: "scale", nodeId: WEB } });
    render(<ActionDialogs />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().actionDialog).toBeNull();
    expect(scaleObject).not.toHaveBeenCalled();
  });
});

describe("Restart and Rollback confirmations", () => {
  it("Restart confirms, then restarts", () => {
    const restartObject = vi.fn(async () => {});
    useAppStore.setState({ restartObject, actionDialog: { type: "restart", nodeId: WEB } });
    render(<ActionDialogs />);
    const dialog = screen.getByRole("alertdialog", { name: "Restart Deployment web?" });
    expect(dialog).toHaveTextContent("Its pods are replaced according to the rollout strategy.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }));
    expect(restartObject).toHaveBeenCalledWith(WEB);
  });

  it("disables Restart while an action is running", () => {
    useAppStore.setState({ actionBusy: true, actionDialog: { type: "restart", nodeId: WEB } });
    render(<ActionDialogs />);
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
    useAppStore.setState({ actionBusy: false });
  });

  it("Rollback names the revision, then rolls back", () => {
    const rollbackObject = vi.fn(async () => {});
    useAppStore.setState({ rollbackObject, actionDialog: { type: "rollback", nodeId: WEB, revision: 2 } });
    render(<ActionDialogs />);
    const dialog = screen.getByRole("alertdialog", { name: "Roll Deployment web back to revision 2?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rollback" }));
    expect(rollbackObject).toHaveBeenCalledWith(WEB, 2);
  });
});
