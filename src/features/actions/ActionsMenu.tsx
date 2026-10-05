import { useEffect, useRef, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { actionsFor, kindOf, type ActionId } from "./actionKinds";

const LABEL: Record<ActionId, string> = { scale: "Scale…", restart: "Restart", rollback: "Rollback…", delete: "Delete…" };
const WIDTH = 200;

/** The Actions menu, opened from the details header or by right-clicking a node or a table row.
 *  Escape closes it from `useGlobalKeys`. */
export function ActionsMenu() {
  const { menu, close, openActionDialog, requestDelete, requestTab } = useAppStore(useShallow((s) => ({
    menu: s.actionsMenu, close: s.closeActionsMenu, openActionDialog: s.openActionDialog, requestDelete: s.requestDelete, requestTab: s.requestTab,
  })));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, [menu]);
  if (!menu) return null;

  const items = actionsFor(kindOf(menu.nodeId));
  const run = (id: ActionId) => {
    close();
    if (id === "scale" || id === "restart") openActionDialog({ type: id, nodeId: menu.nodeId });
    else if (id === "rollback") requestTab("history");
    else requestDelete(menu.nodeId);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1) + all.length) % all.length]?.focus();
  };
  // Keep the menu on screen when it opens near the right edge.
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - WIDTH - 8));

  return (
    <div data-testid="actions-backdrop" className="fixed inset-0 z-30"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      onContextMenu={(e) => { e.preventDefault(); close(); }}>
      <div ref={ref} role="menu" aria-label="Actions" onKeyDown={onKeyDown} style={{ left, top: menu.y, width: WIDTH }}
        className="absolute rounded-xl border border-border bg-elevated py-1 text-sm">
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
