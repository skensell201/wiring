import type { LogMessage, NodeId } from "../../shared/ipc/types";

export type StreamState = { state: "started" } | { state: "ended" } | { state: "error"; message: string };

export interface LogsState {
  /** Bumped per startLogs; messages from an older session are dropped. */
  gen: number;
  sessionId: number | null;
  nodeId: NodeId | null;
  container: string | null;
  previous: boolean;
  timestamps: boolean;
  status: "idle" | "starting" | "streaming" | "ended" | "error";
  streams: Map<string, StreamState>;
  truncated: boolean;
}

export const initialLogs = (): LogsState => ({
  gen: 0, sessionId: null, nodeId: null, container: null, previous: false, timestamps: false, status: "idle", streams: new Map(), truncated: false,
});

export const streamKey = (pod: string, container: string) => `${pod}/${container}`;

/** Stream bookkeeping for one message; lines go to the buffer, not here. */
export function applyLogMessage(s: LogsState, m: LogMessage): LogsState {
  if (m.type === "lines") return s;
  if (m.type === "truncated") return { ...s, truncated: true };
  const streams = new Map(s.streams);
  streams.set(streamKey(m.pod, m.container), m.type === "error" ? { state: "error", message: m.message } : { state: m.type });
  const states = [...streams.values()].map((v) => v.state);
  const status: LogsState["status"] = states.includes("started") ? "streaming" : states.every((v) => v === "error") ? "error" : "ended";
  return { ...s, streams, status };
}
