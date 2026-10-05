import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore, viewEditor } from "../../app/store";
import type { GraphNode, K8sEvent } from "../../shared/ipc/types";
import { ProblemBlock } from "./ProblemBlock";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const dep: GraphNode = {
  id: "Deployment/p/bad", kind: "Deployment", namespace: "p", name: "bad", status: "warn", badges: ["0/1"], group: null,
  problem: { reason: "1 of 1 not ready", message: null, cause: "Pod/p/bad-1" },
};
const pod: GraphNode = {
  id: "Pod/p/bad-1", kind: "Pod", namespace: "p", name: "bad-1", status: "err", badges: ["ImagePullBackOff"], group: null,
  problem: { reason: "ImagePullBackOff", message: "container web: Back-off pulling image \"nginx:nope\"", cause: null },
};
const pvc: GraphNode = {
  id: "PersistentVolumeClaim/p/data", kind: "PersistentVolumeClaim", namespace: "p", name: "data", status: "warn", badges: [], group: null,
  problem: { reason: "Pending", message: null, cause: null },
};
const ok: GraphNode = { id: "Service/p/web", kind: "Service", namespace: "p", name: "web", status: "ok", badges: [], group: null };
const warning: K8sEvent = { name: "e1", type: "Warning", reason: "ProvisioningFailed", message: "storageclass \"fast\" not found", count: 2, firstTimestamp: null, lastTimestamp: null };
const normal: K8sEvent = { ...warning, name: "e0", type: "Normal", reason: "Provisioning", message: "waiting" };

function showing(id: string, events: K8sEvent[] = []) {
  useAppStore.setState({
    ...applySnapshot(initialState(), { nodes: [dep, pod, pvc, ok], edges: [] }),
    selectedId: id,
    details: { nodeId: id, loading: false, editor: viewEditor(""), data: { yaml: "", summary: [], related: [] }, events },
  });
}

beforeEach(() => showing(dep.id));

describe("ProblemBlock", () => {
  it("shows the root cause and a clickable path", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ select });
    render(<ProblemBlock nodeId={dep.id} />);
    expect(screen.getByText("ImagePullBackOff")).toBeInTheDocument();
    expect(screen.getByText("container web: Back-off pulling image \"nginx:nope\"")).toBeInTheDocument();
    const path = screen.getByRole("list", { name: "Path" });
    fireEvent.click(screen.getByRole("button", { name: /Pod bad-1/ }));
    expect(select).toHaveBeenCalledWith("Pod/p/bad-1");
    expect(path).toHaveTextContent(/Deployment bad.*Pod bad-1/);
  });

  it("uses the error colour when the root is red, the warning colour otherwise", () => {
    const { unmount } = render(<ProblemBlock nodeId={dep.id} />);
    expect(screen.getByRole("status", { name: "Problem" }).className).toContain("status-err");
    unmount();
    showing(pvc.id);
    render(<ProblemBlock nodeId={pvc.id} />);
    expect(screen.getByRole("status", { name: "Problem" }).className).toContain("status-warn");
  });

  it("falls back to the newest Warning event when the root has no message", () => {
    showing(pvc.id, [normal, warning]);
    render(<ProblemBlock nodeId={pvc.id} />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("ProvisioningFailed — storageclass \"fast\" not found")).toBeInTheDocument();
    expect(screen.getByText("from Events")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Path" })).not.toBeInTheDocument();
  });

  it("does not borrow the selected node's Warning event for a root further down the path", () => {
    showing(dep.id, [warning]);
    useAppStore.setState({ nodes: new Map(useAppStore.getState().nodes).set(pod.id, { ...pod, problem: { reason: "ImagePullBackOff", message: null, cause: null } }) });
    render(<ProblemBlock nodeId={dep.id} />);
    expect(screen.getByText("ImagePullBackOff")).toBeInTheDocument();
    expect(screen.queryByText(/storageclass/)).not.toBeInTheDocument();
    expect(screen.queryByText("from Events")).not.toBeInTheDocument();
  });

  it("renders nothing for a healthy node", () => {
    showing(ok.id, [warning]);
    const { container } = render(<ProblemBlock nodeId={ok.id} />);
    expect(container).toBeEmptyDOMElement();
  });
});
