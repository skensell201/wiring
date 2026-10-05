import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { actionsFor, kindOf, type ActionId } from "./actionKinds";

const LABEL: Record<ActionId, string> = { scale: "Scale…", restart: "Restart", rollback: "Rollback…", delete: "Delete…" };
const WIDTH = 200;
const MARGIN = 8;

/** The Actions menu, opened from the details header or by right-clicking a node or a table row.
 *  Escape closes it from `useGlobalKeys`. */
export function ActionsMenu() {
  const { menu, close, openActionDialog, requestDelete, requestTab } = useAppStore(useShallow((s) => ({
    menu: s.actionsMenu, close: s.closeActionsMenu, openActionDialog: s.openActionDialog, requestDelete: s.requestDelete, requestTab: s.requestTab,
  })));
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  // Place the menu inside the viewport: flip above the anchor when it would overflow the bottom, then clamp.
  useLayoutEffect(() => {
    if (!menu) { setPos(null); return; }
    const { width = WIDTH, height = 0 } = ref.current?.getBoundingClientRect() ?? {};
    let top = menu.y;
    if (top + height > window.innerHeight - MARGIN) top = (menu.flipY ?? menu.y) - height;
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));
    const left = Math.max(MARGIN, Math.min(menu.x, window.innerWidth - width - MARGIN));
    setPos({ left, top });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    opener.current = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("resize", close);
      // Give focus back to the opener, unless the chosen item opened a dialog that took it.
      const target = opener.current;
      opener.current = null;
      queueMicrotask(() => {
        if (!target?.isConnected || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
        const a = document.activeElement;
        if (!a || a === document.body) target.focus();
      });
    };
  }, [menu, close]);
  if (!menu) return null;

  const items = actionsFor(kindOf(menu.nodeId));
  const run = (id: ActionId) => {
    close();
    if (id === "scale" || id === "restart") openActionDialog({ type: id, nodeId: menu.nodeId });
    else if (id === "rollback") requestTab("history");
    else requestDelete(menu.nodeId);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") { close(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1) + all.length) % all.length]?.focus();
  };
  const { left, top } = pos ?? { left: menu.x, top: menu.y };

  return (
    <div data-testid="actions-backdrop" className="fixed inset-0 z-30"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div ref={ref} role="menu" aria-label="Actions" onKeyDown={onKeyDown} style={{ left, top, width: WIDTH }}
        className="absolute rounded-card border border-border bg-elevated py-1 text-sm">
        {items.map((id) => (
          <div key={id}>
            {id === "delete" && items.length > 1 && <div role="separator" className="my-1 border-t border-border" />}
            <button type="button" role="menuitem" onClick={() => run(id)}
              className={`block w-full px-3 py-1.5 text-left outline-none hover:bg-surface focus-visible:bg-surface ${id === "delete" ? "text-status-err" : "text-text-hi"}`}>
              {LABEL[id]}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
