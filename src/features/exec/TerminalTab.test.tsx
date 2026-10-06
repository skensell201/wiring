import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecMessage } from "../../shared/ipc/types";
import { TerminalTab } from "./TerminalTab";

const fakeTerm = {
  write: vi.fn(), onData: vi.fn(), onBinary: vi.fn(), onResize: vi.fn(), fit: vi.fn(), focus: vi.fn(), dispose: vi.fn(),
  cols: 100, rows: 30,
};
vi.mock("./terminal", () => ({ createTerminal: vi.fn(() => fakeTerm) }));

const execPods = vi.fn();
const startExec = vi.fn();
const stopExec = vi.fn();
const execInput = vi.fn();
const execResize = vi.fn();
vi.mock("../../shared/ipc/commands", () => ({
  commands: {
    execPods: (...a: unknown[]) => execPods(...a),
    startExec: (...a: unknown[]) => startExec(...a),
    stopExec: (...a: unknown[]) => stopExec(...a),
    execInput: (...a: unknown[]) => execInput(...a),
    execResize: (...a: unknown[]) => execResize(...a),
  },
}));

const roCallbacks: Array<() => void> = [];
class FakeRO { constructor(cb: () => void) { roCallbacks.push(cb); } observe() {} disconnect() {} unobserve() {} }
vi.stubGlobal("ResizeObserver", FakeRO);

let push: (m: ExecMessage) => void;
beforeEach(() => {
  vi.clearAllMocks();
  roCallbacks.length = 0;
  execPods.mockResolvedValue([
    { name: "web-a", containers: ["app", "sidecar"] },
    { name: "web-b", containers: ["app"] },
  ]);
  startExec.mockImplementation(async (_r: unknown, onMessage: (m: ExecMessage) => void) => { push = onMessage; return 7; });
  stopExec.mockResolvedValue(null);
  execInput.mockResolvedValue(null);
  execResize.mockResolvedValue(null);
});

async function connected() {
  const view = render(<TerminalTab nodeId="Deployment/shop/web" />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  await waitFor(() => expect(startExec).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

describe("TerminalTab", () => {
  it("offers the workload's pods and their containers, and connects to the chosen one", async () => {
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    const pod = await screen.findByRole("combobox", { name: "Pod" });
    fireEvent.change(pod, { target: { value: "web-b" } });
    expect((screen.getByRole("combobox", { name: "Container" }) as HTMLSelectElement).value).toBe("app");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    expect(startExec.mock.calls[0][0]).toEqual({ nodeId: "Deployment/shop/web", pod: "web-b", container: "app", cols: 100, rows: 30 });
    expect(fakeTerm.focus).toHaveBeenCalled();
  });

  it("has no pod picker for a Pod", async () => {
    execPods.mockResolvedValue([{ name: "solo", containers: ["main"] }]);
    render(<TerminalTab nodeId="Pod/shop/solo" />);
    await screen.findByRole("combobox", { name: "Container" });
    expect(screen.queryByRole("combobox", { name: "Pod" })).toBeNull();
  });

  it("writes output and offers Reconnect after the session ends", async () => {
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    act(() => push({ type: "output", sessionId: 7, data: "aGkK" }));
    expect(fakeTerm.write).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    act(() => push({ type: "ended", sessionId: 7, code: 0, message: null }));
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(fakeTerm.write).toHaveBeenLastCalledWith(expect.stringContaining("session ended"));
  });

  it("says so when there is no running pod", async () => {
    execPods.mockResolvedValue([]);
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    expect(await screen.findByText("No running pods to open a terminal in.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("keeps keys typed in the terminal away from app shortcuts", async () => {
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    await screen.findByRole("button", { name: "Connect" });
    const box = document.querySelector("[data-terminal]")!;
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.keyDown(box, { key: "k", metaKey: true });
    expect(onWindowKey).not.toHaveBeenCalled();
    // Outside the terminal, keys still reach the app.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onWindowKey).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", onWindowKey);
  });

  it("refits when the container resizes", async () => {
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    fakeTerm.fit.mockClear();
    act(() => roCallbacks.forEach((cb) => cb()));
    expect(fakeTerm.fit).toHaveBeenCalled();
  });

  it("forwards typed text and xterm binary data to the shell", async () => {
    await connected();
    act(() => fakeTerm.onData.mock.calls[0][0]("ls"));
    expect(execInput).toHaveBeenLastCalledWith(7, btoa("ls"));
    await act(async () => {});
    act(() => fakeTerm.onBinary.mock.calls[0][0](new Uint8Array([0xff, 0x01])));
    expect(execInput).toHaveBeenLastCalledWith(7, btoa("\xff\x01"));
  });

  it("debounces resizes and always sends the final size", async () => {
    await connected();
    vi.useFakeTimers();
    try {
      const onResize = fakeTerm.onResize.mock.calls[0][0] as (c: number, r: number) => void;
      act(() => { onResize(101, 31); onResize(110, 35); onResize(120, 50); });
      act(() => { vi.advanceTimersByTime(99); });
      expect(execResize).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(execResize.mock.calls).toEqual([[7, 120, 50]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the no-shell message as a line", async () => {
    render(<TerminalTab nodeId="Deployment/shop/web" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    act(() => push({ type: "ended", sessionId: 7, code: null, message: "no shell in image" }));
    expect(fakeTerm.write).toHaveBeenLastCalledWith(expect.stringContaining("no shell in image"));
  });

  it("stops the session and disposes the terminal on unmount", async () => {
    const { unmount } = render(<TerminalTab nodeId="Deployment/shop/web" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    unmount();
    expect(stopExec).toHaveBeenCalledWith(7);
    expect(fakeTerm.dispose).toHaveBeenCalled();
  });
});
