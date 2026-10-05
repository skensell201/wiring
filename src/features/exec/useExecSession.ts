import { useCallback, useEffect, useRef, useState } from "react";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type ExecMessage, type ExecRequest } from "../../shared/ipc/types";
import { decodeBytes, encodeText } from "./base64";

export type ExecStatus = "idle" | "connecting" | "open" | "ended";
export interface ExecHandlers { onOutput(bytes: Uint8Array): void; onEnd(line: string): void }

/** The line written into the terminal when a session ends or fails. */
export function endLine(m: Exclude<ExecMessage, { type: "output" }>): string {
  if (m.type === "error") return `\r\n[${m.message}]\r\n`;
  const code = m.code !== null ? ` (exit code ${m.code})` : "";
  return `\r\n[${m.message ? `${m.message} · ` : ""}session ended${code}]\r\n`;
}

/** One exec session at a time: `connect` replaces any previous one; unmount stops it. */
export function useExecSession(handlers: ExecHandlers) {
  const [status, setStatus] = useState<ExecStatus>("idle");
  const sessionId = useRef<number | null>(null);
  const generation = useRef(0);
  const h = useRef(handlers);
  h.current = handlers;

  const stop = useCallback(() => {
    generation.current++;
    const id = sessionId.current;
    sessionId.current = null;
    if (id !== null) void commands.stopExec(id);
  }, []);

  const connect = useCallback(async (req: ExecRequest) => {
    stop();
    const mine = generation.current;
    setStatus("connecting");
    try {
      const id = await commands.startExec(req, (m) => {
        if (mine !== generation.current) return;
        if (m.type === "output") {
          setStatus("open");
          h.current.onOutput(decodeBytes(m.data));
        } else {
          sessionId.current = null;
          setStatus("ended");
          h.current.onEnd(endLine(m));
        }
      });
      if (mine !== generation.current) { void commands.stopExec(id); return; }
      sessionId.current = id;
    } catch (e) {
      if (mine !== generation.current) return;
      setStatus("ended");
      h.current.onEnd(`\r\n[${toAppError(e).message}]\r\n`);
    }
  }, [stop]);

  const send = useCallback((text: string) => {
    const id = sessionId.current;
    if (id !== null) void commands.execInput(id, encodeText(text));
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    const id = sessionId.current;
    if (id !== null) void commands.execResize(id, cols, rows);
  }, []);

  const disconnect = useCallback(() => {
    const wasLive = sessionId.current !== null;
    stop();
    setStatus("ended");
    if (wasLive) h.current.onEnd("\r\n[session ended]\r\n");
  }, [stop]);

  useEffect(() => stop, [stop]);
  return { status, connect, send, resize, disconnect };
}
