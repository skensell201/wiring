import { Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { NamespaceScope } from "../../shared/ipc/types";
import { scopeLabel } from "../../shared/scope";
import { Button } from "../../shared/ui/Button";

const FIELD = "no-drag h-9 rounded-xl border border-border-strong bg-transparent px-3 text-sm font-medium text-text-hi outline-none focus:border-accent";
const ROW = "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm text-text-hi hover:bg-surface focus:bg-surface focus:outline-none";
const WIDTH = 288;
const MARGIN = 8;
/** The backend accepts at most this many explicit namespaces. */
export const MAX_NAMESPACES = 20;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** One namespace (click its name), several (tick them, then Apply) or all of them. */
export function NamespacePicker() {
  const { namespaces, canList, scope, selectScope } = useAppStore(useShallow((s) => ({
    namespaces: s.connection.namespaces, canList: s.connection.canListNamespaces, scope: s.connection.scope, selectScope: s.selectScope,
  })));
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Opens downward from the button, clamped to the viewport; portalled out of the header's backdrop blur.
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

  const apply = (next: NamespaceScope) => {
    setOpen(false);
    void selectScope(next);
  };

  const valid = DNS_LABEL.test(draft.trim()) && draft.trim().length <= 63;
  if (namespaces.length === 0) {
    return (
      <input aria-label="Namespace" aria-invalid={draft.trim() !== "" && !valid} className={FIELD} placeholder="namespace…" value={draft}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && valid) apply([draft.trim()]); }} />
    );
  }

  const toggleOpen = () => {
    if (!open) {
      setTicked(new Set(scope === null || scope === "all" ? [] : scope));
      setFilter("");
    }
    setOpen(!open);
  };
  const toggle = (ns: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(ns)) next.delete(ns); else if (next.size < MAX_NAMESPACES) next.add(ns);
    return next;
  });
  const q = filter.trim().toLowerCase();
  const shown = namespaces.filter((ns) => ns.toLowerCase().includes(q));
  const full = ticked.size >= MAX_NAMESPACES;

  const onKeyDown = (e: KeyboardEvent) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])];
    const active = document.activeElement as HTMLElement | null;
    const i = active ? items.indexOf(active) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      items[next]?.focus();
    } else if (e.key === " " && active?.dataset.ns) {
      e.preventDefault();
      toggle(active.dataset.ns);
    } else if (e.key === "Enter") {
      // A row applies itself; anywhere else Enter applies the ticked set.
      if (active?.dataset.all !== undefined) { e.preventDefault(); apply("all"); }
      else if (active?.dataset.ns) { e.preventDefault(); apply([active.dataset.ns]); }
      else if (ticked.size > 0) { e.preventDefault(); apply([...ticked].sort()); }
    }
  };

  return (
    <div className="no-drag relative">
      <button ref={button} type="button" aria-label="Namespace" aria-haspopup="dialog" aria-expanded={open} className={`${FIELD} flex items-center gap-2`} onClick={toggleOpen}>
        <span className="max-w-56 truncate">{scopeLabel(scope, namespaces, 2) || "namespace…"}</span>
        <ChevronDown className="size-4 text-text-muted" />
      </button>
      {open && createPortal(
        <>
          <div data-testid="namespaces-backdrop" className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
          <div ref={panel} role="dialog" aria-label="Namespaces" onKeyDown={onKeyDown}
            style={{ left: pos?.left ?? MARGIN, top: pos?.top ?? 64, width: WIDTH, maxWidth: `calc(100vw - ${2 * MARGIN}px)` }}
            className="fixed z-40 rounded-card border border-border bg-elevated p-2 text-sm">
            <input data-nav autoFocus aria-label="Filter namespaces" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)}
              className="mb-2 h-8 w-full rounded-lg border border-border-strong bg-surface px-2 text-sm text-text-hi outline-none focus:border-accent" />
            {canList && (
              <button type="button" data-nav data-all className={`${ROW} w-full`} onClick={() => apply("all")}>
                <span className="w-4">{scope === "all" && <Check className="size-4 text-accent" />}</span>
                All namespaces ({namespaces.length})
              </button>
            )}
            <ul className="max-h-72 overflow-auto">
              {shown.map((ns) => (
                <li key={ns} className="flex items-center gap-1 pl-2">
                  <input type="checkbox" aria-label={`Include ${ns}`} tabIndex={-1} checked={ticked.has(ns)} disabled={full && !ticked.has(ns)} onChange={() => toggle(ns)} />
                  <button type="button" data-nav data-ns={ns} className={ROW} onClick={() => apply([ns])}>{ns}</button>
                </li>
              ))}
              {shown.length === 0 && <li className="px-2 py-1.5 text-xs text-text-muted">No match.</li>}
            </ul>
            {!canList && (
              <input aria-label="Add a namespace" aria-invalid={draft.trim() !== "" && !valid} placeholder="Other namespace…" value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); if (valid) apply([draft.trim()]); } }}
                className="mt-2 h-8 w-full rounded-lg border border-border-strong bg-surface px-2 text-sm text-text-hi outline-none focus:border-accent" />
            )}
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-text-muted">{full ? `Up to ${MAX_NAMESPACES} — or pick All namespaces` : ""}</span>
              <Button variant="primary" disabled={ticked.size === 0} onClick={() => apply([...ticked].sort())}>
                {ticked.size > 0 ? `Apply (${ticked.size})` : "Apply"}
              </Button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
