import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecMessage } from "../../shared/ipc/types";
import { encodeText } from "./base64";
import { endLine, MAX_INPUT_CHUNK, useExecSession } from "./useExecSession";

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

  it("keeps one input in flight and sends what arrived meanwhile next, in order", async () => {
    const pending: Array<() => void> = [];
    execInput.mockImplementation(() => new Promise<null>((resolve) => pending.push(() => resolve(null))));
    const { result } = setup();
    await act(() => result.current.connect(req));
    act(() => { result.current.send("a"); result.current.send("b"); result.current.send("c"); });
    expect(execInput.mock.calls).toEqual([[1, encodeText("a")]]);
    await act(async () => { pending.shift()!(); });
    expect(execInput.mock.calls).toEqual([[1, encodeText("a")], [1, encodeText("bc")]]);
    act(() => result.current.send("d"));
    expect(execInput).toHaveBeenCalledTimes(2);
    await act(async () => { pending.shift()!(); });
    expect(execInput.mock.calls[2]).toEqual([1, encodeText("d")]);
  });

  it("splits a large paste into chunks below the backend's 1 MiB limit, in order", async () => {
    const { result } = setup();
    await act(() => result.current.connect(req));
    const paste = "x".repeat(MAX_INPUT_CHUNK * 2 + 5);
    act(() => result.current.send(paste));
    for (let i = 0; i < 3; i++) await act(async () => {});
    const sizes = execInput.mock.calls.map(([, b64]) => atob(b64 as string).length);
    expect(sizes).toEqual([MAX_INPUT_CHUNK, MAX_INPUT_CHUNK, 5]);
    expect(MAX_INPUT_CHUNK).toBeLessThanOrEqual(1024 * 1024);
  });

  it("a failed input does not stall the queue", async () => {
    execInput.mockRejectedValueOnce({ kind: "invalid", message: "x" });
    const { result } = setup();
    await act(() => result.current.connect(req));
    act(() => result.current.send("a"));
    await act(async () => { result.current.send("b"); });
    await act(async () => {});
    expect(execInput.mock.calls).toEqual([[1, encodeText("a")], [1, encodeText("b")]]);
  });

  it("buffers input and the latest size issued while connecting, then flushes them", async () => {
    let resolveStart!: (id: number) => void;
    startExec.mockImplementationOnce((_r: unknown, onMessage: (m: ExecMessage) => void) => {
      push = onMessage;
      return new Promise<number>((resolve) => { resolveStart = resolve; });
    });
    const { result } = setup();
    let connecting!: Promise<void>;
    act(() => { connecting = result.current.connect(req); });
    act(() => { result.current.send("ls"); result.current.send("\r"); result.current.resize(90, 30); result.current.resize(100, 40); });
    expect(execInput).not.toHaveBeenCalled();
    expect(execResize).not.toHaveBeenCalled();
    await act(async () => { resolveStart(5); await connecting; });
    expect(execInput.mock.calls).toEqual([[5, encodeText("ls\r")]]);
    expect(execResize.mock.calls).toEqual([[5, 100, 40]]);
  });

  it("sends raw bytes (xterm binary data) as base64", async () => {
    const { result } = setup();
    await act(() => result.current.connect(req));
    act(() => result.current.send(new Uint8Array([0xff, 0x00, 0x80])));
    expect(execInput).toHaveBeenCalledWith(1, btoa("\xff\x00\x80"));
  });

  it("drops input once the session is gone", async () => {
    const { result } = setup();
    await act(() => result.current.connect(req));
    act(() => result.current.disconnect());
    act(() => result.current.send("x"));
    expect(execInput).not.toHaveBeenCalled();
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
