import { describe, expect, it } from "vitest";
import { applyLogMessage, initialLogs, streamKey, type LogsState } from "./logsState";

const base = (): LogsState => ({ ...initialLogs(), nodeId: "Pod/p/a", status: "starting" });

describe("applyLogMessage", () => {
  it("started marks the stream and the session as streaming", () => {
    const s = applyLogMessage(base(), { type: "started", sessionId: 1, pod: "a", container: "c" });
    expect(s.status).toBe("streaming");
    expect(s.streams.get(streamKey("a", "c"))).toEqual({ state: "started" });
  });

  it("ended on every stream ends the session; a later started resumes it", () => {
    let s = applyLogMessage(base(), { type: "started", sessionId: 1, pod: "a", container: "c" });
    s = applyLogMessage(s, { type: "ended", sessionId: 1, pod: "a", container: "c" });
    expect(s.status).toBe("ended");
    s = applyLogMessage(s, { type: "started", sessionId: 1, pod: "b", container: "c" });
    expect(s.status).toBe("streaming");
  });

  it("error keeps the message on the stream; all-error is status error", () => {
    const s = applyLogMessage(base(), { type: "error", sessionId: 1, pod: "a", container: "c", message: "waiting to start" });
    expect(s.streams.get(streamKey("a", "c"))).toEqual({ state: "error", message: "waiting to start" });
    expect(s.status).toBe("error");
  });

  it("truncated sets the flag; lines change nothing here", () => {
    const s = applyLogMessage(base(), { type: "truncated", sessionId: 1, limit: 64 });
    expect(s.truncated).toBe(true);
    expect(applyLogMessage(s, { type: "lines", sessionId: 1, lines: [] })).toBe(s);
  });
});
