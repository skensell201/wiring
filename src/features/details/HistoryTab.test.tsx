import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import type { GraphNode, Revision } from "../../shared/ipc/types";
import { HistoryTab } from "./HistoryTab";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const WEB = "Deployment/p/web";
const web: GraphNode = { id: WEB, kind: "Deployment", namespace: "p", name: "web", status: "ok", badges: ["3/3"], group: null };
const DB = "StatefulSet/p/db";
const db: GraphNode = { id: DB, kind: "StatefulSet", namespace: "p", name: "db", status: "ok", badges: ["1/1"], group: null };
const REVISIONS: Revision[] = [
  { revision: 2, current: true, createdAt: "2026-10-05T10:00:00Z", changeCause: null, images: ["web:2"], template: "image: web:2\n" },
  { revision: 1, current: false, createdAt: "2026-10-01T10:00:00Z", changeCause: "first release", images: ["web:1"], template: "image: web:1\n" },
];
const historyCalls = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "rollout_history").length;

beforeEach(() => {
  useAppStore.setState(applySnapshot(initialState(), { nodes: [web, db], edges: [] }));
  vi.mocked(invoke).mockReset().mockImplementation(async (cmd: string) => (cmd === "rollout_history" ? REVISIONS : null));
});
afterEach(() => { vi.useRealTimers(); });

describe("HistoryTab", () => {
  it("lists revisions newest first, the current one marked and not pickable", async () => {
    render(<HistoryTab nodeId={WEB} />);
    expect(await screen.findByText("#2")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("rollout_history", { nodeId: WEB });
    expect(screen.getByText("current")).toBeInTheDocument();
    expect(screen.getByText("first release")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /#2/ })).toBeDisabled();
    expect(screen.getByText(/pick a revision/i)).toBeInTheDocument();
  });

  it("picking a revision shows its diff against the current one and offers the rollback", async () => {
    render(<HistoryTab nodeId={WEB} />);
    fireEvent.click(await screen.findByRole("button", { name: /#1/ }));
    expect(screen.getByText("- image: web:2")).toBeInTheDocument();
    expect(screen.getByText("+ image: web:1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rollback to 1" }));
    expect(useAppStore.getState().actionDialog).toEqual({ type: "rollback", nodeId: WEB, revision: 1 });
  });

  it("without a current entry it compares against the newest and still allows rolling back to the others", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "rollout_history" ? REVISIONS.map((r) => ({ ...r, current: false })) : null));
    render(<HistoryTab nodeId={WEB} />);
    await screen.findByText("#2");
    expect(screen.queryByText("current")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /#2/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /#1/ }));
    expect(screen.getByText("- image: web:2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rollback to 1" })).toBeInTheDocument();
  });

  it("says so when the role cannot read the history", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "rollout_history") throw { kind: "forbidden", message: "forbidden" };
      return null;
    });
    const { unmount } = render(<HistoryTab nodeId={DB} />);
    expect(await screen.findByText("No permission to read revision history (controllerrevisions).")).toBeInTheDocument();
    unmount();
    render(<HistoryTab nodeId={WEB} />);
    expect(await screen.findByText("No permission to read revision history (replicasets).")).toBeInTheDocument();
  });

  it("refetches when the workload changes, at most once a second", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<HistoryTab nodeId={WEB} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(await screen.findByText("#2")).toBeInTheDocument();
    expect(historyCalls()).toBe(1);
    act(() => useAppStore.getState().applyDelta({ addedNodes: [], updatedNodes: [{ ...web, badges: ["2/3"] }], removedNodes: [], addedEdges: [], removedEdges: [] }));
    expect(historyCalls()).toBe(1); // throttled
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(historyCalls()).toBe(2);
  });
});
