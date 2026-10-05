import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecMessage } from "../../shared/ipc/types";
import { encodeText } from "./base64";
import { endLine, useExecSession } from "./useExecSession";

const startExec = vi.fn();
const stopExec = vi.fn();
const execInput = vi.fn();
const execResize = vi.fn();
vi.mock("../../shared/ipc/commands", () => ({
  commands: {
    startExec: (...a: unknown[]) => startExec(...a),
    stopExec: (...a: unknown[]) => stopExec(...a),
    execInput: (...a: unknown[]) => execInput(...a),
    execResize: (...a: unknown[]) => execResize(...a),
  },
}));

const req = { nodeId: "Pod/shop/solo", pod: "solo", container: "main", cols: 80, rows: 24 };
let push: (m: ExecMessage) => void;

beforeEach(() => {
  vi.clearAllMocks();
  let next = 1;
  startExec.mockImplementation(async (_req: unknown, onMessage: (m: ExecMessage) => void) => { push = onMessage; return next++; });
  stopExec.mockResolvedValue(null);
  execInput.mockResolvedValue(null);
  execResize.mockResolvedValue(null);
});

function setup() {
  const onOutput = vi.fn();
  const onEnd = vi.fn();
  const hook = renderHook(() => useExecSession({ onOutput, onEnd }));
  return { ...hook, onOutput, onEnd };
}

describe("useExecSession", () => {
  it("connects, forwards output bytes and becomes open", async () => {
    const { result, onOutput } = setup();
    await act(() => result.current.connect(req));
    expect(startExec).toHaveBeenCalledWith(req, expect.any(Function));
    expect(result.current.status).toBe("connecting");
    act(() => push({ type: "output", sessionId: 1, data: "aGkK" }));
    expect([...onOutput.mock.calls[0][0]]).toEqual([0x68, 0x69, 0x0a]);
    expect(result.current.status).toBe("open");
  });

  it("sends keystrokes and resizes to the session", async () => {
    const { result } = setup();
    await act(() => result.current.connect(req));
    act(() => result.current.send("ls\r"));
    expect(execInput).toHaveBeenCalledWith(1, encodeText("ls\r"));
    act(() => result.current.resize(100, 40));
    expect(execResize).toHaveBeenCalledWith(1, 100, 40);
  });

  it("ends with a line naming the exit code", async () => {
    const { result, onEnd } = setup();
    await act(() => result.current.connect(req));
    act(() => push({ type: "ended", sessionId: 1, code: 3, message: null }));
    expect(result.current.status).toBe("ended");
    expect(onEnd).toHaveBeenCalledWith(endLine({ type: "ended", sessionId: 1, code: 3, message: null }));
    expect(endLine({ type: "ended", sessionId: 1, code: 3, message: null })).toContain("exit code 3");
    expect(endLine({ type: "error", sessionId: 1, message: "No permission" })).toContain("No permission");
  });

  it("reconnecting stops the old session and ignores its late messages", async () => {
    const { result, onOutput } = setup();
    await act(() => result.current.connect(req));
    const old = push;
    await act(() => result.current.connect(req));
    expect(stopExec).toHaveBeenCalledWith(1);
    act(() => old({ type: "output", sessionId: 1, data: "aGkK" }));
    expect(onOutput).not.toHaveBeenCalled();
  });

  it("a rejected start ends with its message", async () => {
    startExec.mockRejectedValueOnce({ kind: "invalid", message: "pod gone" });
    const { result, onEnd } = setup();
    await act(() => result.current.connect(req));
    expect(result.current.status).toBe("ended");
    expect(onEnd.mock.calls[0][0]).toContain("pod gone");
  });

  it("unmount stops the session", async () => {
    const { result, unmount } = setup();
    await act(() => result.current.connect(req));
    unmount();
    expect(stopExec).toHaveBeenCalledWith(1);
  });
});
