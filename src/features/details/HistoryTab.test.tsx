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
    vi.useFakeTimers();
    render(<HistoryTab nodeId={WEB} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(historyCalls()).toBe(1);
    act(() => useAppStore.getState().applyDelta({ addedNodes: [], updatedNodes: [{ ...web, badges: ["2/3"] }], removedNodes: [], addedEdges: [], removedEdges: [] }));
    expect(historyCalls()).toBe(1); // throttled
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(historyCalls()).toBe(2);
  });

  const delta = (badge: string) => act(() => useAppStore.getState().applyDelta({ addedNodes: [], updatedNodes: [{ ...web, badges: [badge] }], removedNodes: [], addedEdges: [], removedEdges: [] }));
  const deferred = () => { let resolve!: (r: Revision[]) => void; let reject!: (e: unknown) => void; const promise = new Promise<Revision[]>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
  const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("still shows a fetch's result when a delta arrives while it is in flight", async () => {
    vi.useFakeTimers();
    const first = deferred();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "rollout_history" ? first.promise : null));
    render(<HistoryTab nodeId={WEB} />);
    await flush();
    delta("2/3");
    first.resolve(REVISIONS);
    await flush();
    expect(screen.getByText("#2")).toBeInTheDocument();
  });

  it("collapses a burst of deltas into one trailing fetch", async () => {
    vi.useFakeTimers();
    render(<HistoryTab nodeId={WEB} />);
    await flush();
    expect(historyCalls()).toBe(1);
    delta("1/3"); delta("2/3"); delta("3/3");
    await flush(1000);
    expect(historyCalls()).toBe(2);
    await flush(3000);
    expect(historyCalls()).toBe(2);
  });

  it("does not let an older, slower response overwrite a newer one", async () => {
    vi.useFakeTimers();
    const slow = deferred();
    let n = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== "rollout_history") return null;
      return ++n === 1 ? slow.promise : [{ ...REVISIONS[0], revision: 3, current: true }];
    });
    render(<HistoryTab nodeId={WEB} />);
    await flush();
    delta("2/3");
    await flush(1000);
    expect(screen.getByText("#3")).toBeInTheDocument();
    slow.resolve(REVISIONS);
    await flush();
    expect(screen.getByText("#3")).toBeInTheDocument();
    expect(screen.queryByText("#1")).not.toBeInTheDocument();
  });

  it("keeps the list and shows an inline error when a refetch fails", async () => {
    vi.useFakeTimers();
    render(<HistoryTab nodeId={WEB} />);
    await flush();
    vi.mocked(invoke).mockImplementation(async () => { throw { kind: "internal", message: "boom" }; });
    delta("2/3");
    await flush(1000);
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh the history: boom/)).toBeInTheDocument();
  });

  it("clears the selection when the picked revision vanishes or becomes the base", async () => {
    vi.useFakeTimers();
    render(<HistoryTab nodeId={WEB} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /#1/ }));
    expect(screen.getByRole("button", { name: "Rollback to 1" })).toBeInTheDocument();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "rollout_history" ? [REVISIONS[0]] : null));
    delta("2/3");
    await flush(1000);
    expect(screen.queryByRole("button", { name: "Rollback to 1" })).not.toBeInTheDocument();
    // it comes back, but the old pick must not silently return
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "rollout_history" ? REVISIONS : null));
    delta("3/3");
    await flush(1000);
    expect(screen.queryByRole("button", { name: "Rollback to 1" })).not.toBeInTheDocument();
  });

  it("says newest when no entry is marked current", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "rollout_history" ? REVISIONS.map((r) => ({ ...r, current: false })) : null));
    render(<HistoryTab nodeId={WEB} />);
    await screen.findByText("#2");
    expect(screen.getByText("Pick a revision to compare it with the newest one.")).toBeInTheDocument();
  });
});
