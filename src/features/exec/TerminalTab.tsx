import { useEffect, useRef, useState } from "react";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type ExecPod, type NodeId } from "../../shared/ipc/types";
import type { TermHandle } from "./terminal";
import { useExecSession } from "./useExecSession";

const select = "h-8 rounded-lg border border-border bg-surface px-2 text-xs text-text-hi";
/** Sizes sent to the shell settle this long after the last change (a drag sends a burst). */
const RESIZE_DEBOUNCE_MS = 100;
const action = "h-8 rounded-lg border border-border px-3 text-xs font-medium text-text-hi hover:bg-surface disabled:opacity-40";

/** An interactive shell in a running container of the selected Pod or workload (spec §3). */
export function TerminalTab({ nodeId }: { nodeId: NodeId }) {
  const [pods, setPods] = useState<ExecPod[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pod, setPod] = useState("");
  const [container, setContainer] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const term = useRef<TermHandle | null>(null);
  const session = useExecSession({
    onOutput: (bytes) => term.current?.write(bytes),
    onEnd: (line) => term.current?.write(line),
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const isPod = nodeId.startsWith("Pod/");

  useEffect(() => {
    let live = true;
    commands.execPods(nodeId).then(
      (list) => {
        if (!live) return;
        setPods(list);
        setPod(list[0]?.name ?? "");
        setContainer(list[0]?.containers[0] ?? "");
      },
      (e) => { if (live) setLoadError(toAppError(e).message); },
    );
    return () => { live = false; };
  }, [nodeId]);

  // Keys typed in the terminal belong to the shell: keep them from the app's window shortcuts.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const swallow = (e: KeyboardEvent) => e.stopPropagation();
    el.addEventListener("keydown", swallow);
    return () => el.removeEventListener("keydown", swallow);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => term.current?.fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    term.current?.dispose();
    term.current = null;
  }, []);

  async function ensureTerminal(): Promise<TermHandle | null> {
    if (term.current) return term.current;
    if (!box.current) return null;
    const { createTerminal } = await import("./terminal");
    const t = createTerminal(box.current);
    t.onData((data) => sessionRef.current.send(data));
    t.onBinary((bytes) => sessionRef.current.send(bytes));
    t.onLeave(() => toolbar.current?.querySelector<HTMLElement>("select:not(:disabled), button:not(:disabled)")?.focus());
    t.onResize((cols, rows) => {
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => { resizeTimer.current = null; sessionRef.current.resize(cols, rows); }, RESIZE_DEBOUNCE_MS);
    });
    term.current = t;
    return t;
  }

  async function connect() {
    const t = await ensureTerminal();
    if (!t || !pod || !container) return;
    t.focus();
    await session.connect({ nodeId, pod, container, cols: t.cols, rows: t.rows });
  }

  const containers = pods?.find((p) => p.name === pod)?.containers ?? [];
  const live = session.status === "connecting" || session.status === "open";
  const label = live ? "Disconnect" : session.status === "ended" ? "Reconnect" : "Connect";

  let notice: string | null = null;
  if (loadError) notice = `Could not list pods: ${loadError}`;
  else if (pods && pods.length === 0) notice = "No running pods to open a terminal in.";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={toolbar} className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-5">
        {pods && pods.length > 0 && (
          <>
            {!isPod && (
              <select aria-label="Pod" className={select} value={pod} disabled={live}
                onChange={(e) => { setPod(e.target.value); setContainer(pods.find((p) => p.name === e.target.value)?.containers[0] ?? ""); }}>
                {pods.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            )}
            <select aria-label="Container" className={select} value={container} disabled={live} onChange={(e) => setContainer(e.target.value)}>
              {containers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button type="button" className={action} onClick={() => (live ? session.disconnect() : void connect())}>{label}</button>
            <span className="ml-auto text-xs text-text-muted">{session.status === "connecting" ? "connecting…" : session.status === "open" ? "connected" : ""}</span>
            <span className="text-xs text-text-muted"><kbd>Ctrl+Shift+Tab</kbd> to leave</span>
          </>
        )}
        {notice && <span className="text-xs text-text-muted">{notice}</span>}
      </div>
      <div ref={box} data-terminal className="min-h-0 flex-1 bg-surface px-3 py-2" />
    </div>
  );
}
