import { ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { Dot } from "../../shared/ui/Dot";
import { connectContext } from "./connectContext";
import { useAddKubeconfig } from "./useAddKubeconfig";

const WIDTH = 288;
const MARGIN = 8;
const ROW = "flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-text-hi hover:bg-surface focus:bg-surface focus:outline-none";

/** The header's cluster button: the connected cluster's name, or the list to pick from. With no
 *  kubeconfig at all the button is the way in: it says "Add kubeconfig" and opens the file dialog. */
export function ClusterPicker() {
  const { contexts, contextsLoaded, current, state, busy, connecting, serverVersion } = useAppStore(
    useShallow((s) => ({
      contexts: s.contexts, contextsLoaded: s.contextsLoaded,
      current: s.connection.context, state: s.connection.state, busy: s.connection.busy,
      connecting: s.connection.connecting, serverVersion: s.connection.serverVersion,
    })),
  );
  const add = useAddKubeconfig();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Nothing to pick from: the button is the way to a kubeconfig.
  const noContexts = contextsLoaded && contexts.length === 0;
  const label = connecting ?? current ?? (noContexts ? "Add kubeconfig" : "choose cluster");

  // Opens downward from the button, clamped to the viewport; portalled out of the header's blur.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const r = button.current?.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
    setPos({ left: Math.max(MARGIN, Math.min(r?.left ?? MARGIN, window.innerWidth - width - MARGIN)), top: (r?.bottom ?? 0) + 4 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Escape is ours while open: capture it before the app's global handler, which skips handled events.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    const opener = button.current;
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      queueMicrotask(() => {
        if (!opener?.isConnected || document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return;
        const a = document.activeElement;
        if (!a || a === document.body || !a.isConnected) opener.focus();
      });
    };
  }, [open]);

  // A request to choose a cluster ("Choose a cluster", "Choose another cluster") opens the menu.
  // A request made before this mounted is not replayed, and one made with nothing to pick from is
  // dropped on purpose.
  const pickerSeq = useAppStore((s) => s.clusterPickerSeq);
  const seenSeq = useRef(pickerSeq);
  useEffect(() => {
    if (pickerSeq === seenSeq.current) return;
    seenSeq.current = pickerSeq;
    if (contexts.length === 0) return;
    setOpen(true);
  }, [pickerSeq, contexts.length]);

  const onClick = () => {
    if (noContexts) { void add(); return; }
    setOpen(!open);
  };

  return (
    <div className="no-drag relative">
      <button ref={button} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={onClick}
        className="flex h-9 items-center gap-2 rounded-xl border border-border-strong bg-surface px-4 text-sm font-medium text-text-hi hover:bg-muted">
        <span aria-hidden>⎈</span>
        <span className="max-w-56 truncate">{label}</span>
        {connecting !== null
          ? <span role="img" aria-label="Connecting" className="inline-flex align-middle"><LoaderCircle aria-hidden className="size-3.5 text-text-muted motion-safe:animate-spin" /></span>
          : serverVersion ? <span className="text-xs font-normal text-text-muted">{serverVersion}</span> : null}
        {!noContexts && <ChevronDown aria-hidden className="size-4 text-text-muted" />}
      </button>
      {open && createPortal(
        <>
          <div data-testid="clusters-backdrop" className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
          <div ref={panel} role="dialog" aria-label="Clusters"
            style={{ left: pos?.left ?? MARGIN, top: pos?.top ?? 64, width: WIDTH, maxWidth: `calc(100vw - ${2 * MARGIN}px)` }}
            className="fixed z-40 rounded-card border border-border bg-elevated p-2 text-sm">
            {contexts.map((c) => {
              const active = c.name === current;
              return (
                <button key={c.name} type="button" disabled={busy} onClick={() => { setOpen(false); void connectContext(c.name); }} title={c.cluster}
                  className={`${ROW} disabled:opacity-50 ${active ? "inset-hairline bg-surface" : ""}`}>
                  <span className="grid size-2 shrink-0 place-items-center">{active && <Dot status={state} />}</span>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.cluster !== c.name && <span className="min-w-0 max-w-[40%] shrink-0 truncate text-xs text-text-muted">{c.cluster}</span>}
                </button>
              );
            })}
            <div className="my-1 h-px bg-border" />
            <button type="button" onClick={() => { setOpen(false); void add(); }} className={`${ROW} text-text-muted`}>
              <Plus className="size-4" /> Add kubeconfig…
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
