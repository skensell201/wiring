import { ArrowLeftRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { Forward, ForwardStatus, Status } from "../../shared/ipc/types";
import { Dot } from "../../shared/ui/Dot";

const TEXT: Record<ForwardStatus, string> = { active: "active", noReadyPod: "no ready pod", podGone: "pod gone", error: "error" };
const DOT: Record<ForwardStatus, Status> = { active: "ok", noReadyPod: "warn", podGone: "err", error: "err" };
const WIDTH = 416;
const MARGIN = 8;
const action = "rounded-lg px-2 py-0.5 hover:bg-muted hover:text-text-hi";

function detail(f: Forward): string {
  if (f.status === "error") return `error: ${f.message ?? "unknown"}`;
  return f.pod ? `${TEXT[f.status]} · ${f.pod}` : TEXT[f.status];
}

/** `⇄ N` in the header; its popover lists the forwards with Open / Copy / Stop. Escape closes it via `useGlobalKeys`. */
export function ForwardsIndicator() {
  const { forwards, open, setOpen, stop, openUrl } = useAppStore(useShallow((s) => ({
    forwards: s.forwards, open: s.forwardsOpen, setOpen: s.setForwardsOpen, stop: s.stopForward, openUrl: s.openForward,
  })));
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const shown = open && forwards.length > 0;

  // The header is at the top of the window: open downward, right-aligned to the button, clamped to the viewport.
  // Portalled because the header's backdrop blur would otherwise contain the fixed backdrop.
  useLayoutEffect(() => {
    if (!shown) { setPos(null); return; }
    const r = button.current?.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
    const right = r?.right ?? window.innerWidth - MARGIN;
    setPos({ left: Math.max(MARGIN, Math.min(right - width, window.innerWidth - width - MARGIN)), top: (r?.bottom ?? 0) + MARGIN });
  }, [shown, forwards.length]);

  useEffect(() => {
    if (!shown) return;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    const opener = button.current;
    return () => {
      window.removeEventListener("resize", close);
      queueMicrotask(() => {
        if (!opener?.isConnected || document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return;
        const a = document.activeElement;
        if (!a || a === document.body || !a.isConnected) opener.focus();
      });
    };
  }, [shown, setOpen]);

  if (forwards.length === 0) return null;
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Tab") setOpen(false); };
  return (
    <div className="no-drag relative">
      <button ref={button} type="button" aria-label="Port forwards" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-xl border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-text-hi hover:bg-muted">
        <ArrowLeftRight className="size-4" /> {forwards.length}
      </button>
      {shown && createPortal(
        <>
          <div data-testid="forwards-backdrop" className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
          <div ref={panel} role="dialog" aria-label="Port forwards" onKeyDown={onKeyDown}
            style={{ left: pos?.left ?? MARGIN, top: pos?.top ?? 64, width: WIDTH, maxWidth: `calc(100vw - ${2 * MARGIN}px)` }}
            className="fixed z-40 max-h-[70vh] overflow-y-auto rounded-card border border-border bg-elevated p-2 text-sm">
            <ul className="space-y-1">
              {forwards.map((f) => {
                const addr = `localhost:${f.localPort}`;
                return (
                  <li key={f.id} className="rounded-lg px-3 py-2 hover:bg-surface">
                    <div className="flex items-center gap-2">
                      <Dot status={DOT[f.status]} />
                      <span className="font-mono text-text-hi">{addr}</span>
                      <span className="min-w-0 truncate text-text-muted">→ {f.targetLabel} :{f.remotePort}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-xs text-text-muted">
                      <span className="min-w-0 flex-1 truncate">{detail(f)}</span>
                      <button type="button" aria-label={`Open ${addr}`} className={action} onClick={() => void openUrl(f.id)}>Open</button>
                      <button type="button" aria-label={`Copy ${addr}`} className={action} onClick={() => void navigator.clipboard.writeText(`http://${addr}`)}>Copy</button>
                      <button type="button" aria-label={`Stop ${addr}`} className={`${action} text-status-err`} onClick={() => void stop(f.id)}>Stop</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
