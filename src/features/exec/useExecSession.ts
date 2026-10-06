import { useCallback, useEffect, useRef, useState } from "react";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type ExecMessage, type ExecRequest } from "../../shared/ipc/types";
import { decodeBytes, encodeBytes } from "./base64";

export type ExecStatus = "idle" | "connecting" | "open" | "ended";
export interface ExecHandlers { onOutput(bytes: Uint8Array): void; onEnd(line: string): void }

/** The line written into the terminal when a session ends or fails. */
export function endLine(m: Exclude<ExecMessage, { type: "output" }>): string {
  if (m.type === "error") return `\r\n[${m.message}]\r\n`;
  const code = m.code !== null ? ` (exit code ${m.code})` : "";
  return `\r\n[${m.message ? `${m.message} · ` : ""}session ended${code}]\r\n`;
}

/**
 * One session's outgoing side. Input is sent with one `exec_input` in flight at a time (separate
 * invokes would race for the session lock and reorder keystrokes); what arrives meanwhile is
 * concatenated and sent next. Until `startExec` resolves, input and the latest size wait here.
 */
/** Bytes per `exec_input` call; well under the backend's 1 MiB limit (`MAX_INPUT`). */
export const MAX_INPUT_CHUNK = 64 * 1024;

interface Outbox { id: number | null; queue: Uint8Array[]; inFlight: boolean; size: [number, number] | null }

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

function flush(box: Outbox) {
  if (box.id === null) return;
  if (box.size) { const [cols, rows] = box.size; box.size = null; void commands.execResize(box.id, cols, rows); }
  if (box.inFlight || box.queue.length === 0) return;
  let bytes = concat(box.queue.splice(0));
  if (bytes.length > MAX_INPUT_CHUNK) {
    box.queue.push(bytes.subarray(MAX_INPUT_CHUNK));
    bytes = bytes.subarray(0, MAX_INPUT_CHUNK);
  }
  box.inFlight = true;
  commands.execInput(box.id, encodeBytes(bytes)).catch(() => {}).finally(() => { box.inFlight = false; flush(box); });
}

/** One exec session at a time: `connect` replaces any previous one; unmount stops it. */
export function useExecSession(handlers: ExecHandlers) {
  const [status, setStatus] = useState<ExecStatus>("idle");
  const sessionId = useRef<number | null>(null);
  /** The current session's outbox; null when there is none (idle, ended, stopped). */
  const outbox = useRef<Outbox | null>(null);
  const generation = useRef(0);
  const h = useRef(handlers);
  h.current = handlers;

  const stop = useCallback(() => {
    generation.current++;
    const id = sessionId.current;
    sessionId.current = null;
    outbox.current = null;
    if (id !== null) void commands.stopExec(id);
  }, []);

  const connect = useCallback(async (req: ExecRequest) => {
    stop();
    const mine = generation.current;
    const box: Outbox = { id: null, queue: [], inFlight: false, size: null };
    outbox.current = box;
    setStatus("connecting");
    try {
      const id = await commands.startExec(req, (m) => {
        if (mine !== generation.current) return;
        if (m.type === "output") {
          setStatus("open");
          h.current.onOutput(decodeBytes(m.data));
        } else {
          sessionId.current = null;
          outbox.current = null;
          setStatus("ended");
          h.current.onEnd(endLine(m));
        }
      });
      if (mine !== generation.current) { void commands.stopExec(id); return; }
      sessionId.current = id;
      box.id = id;
      if (outbox.current === box) flush(box);
    } catch (e) {
      if (mine !== generation.current) return;
      outbox.current = null;
      setStatus("ended");
      h.current.onEnd(`\r\n[${toAppError(e).message}]\r\n`);
    }
  }, [stop]);

  /** Keystrokes (text, sent as UTF-8) or raw bytes (xterm's binary data). */
  const send = useCallback((data: string | Uint8Array) => {
    const box = outbox.current;
    if (!box) return;
    box.queue.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
    flush(box);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    const box = outbox.current;
    if (!box) return;
    box.size = [cols, rows];
    flush(box);
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
