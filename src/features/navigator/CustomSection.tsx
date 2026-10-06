import { ChevronDown, ChevronRight, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { refKey } from "../../shared/customId";
import type { CustomKind } from "../../shared/ipc/types";
import { ACTIVE, IDLE, ROW, SectionGroup } from "./treeParts";

/** Custom Resources: the API groups discovery found, each expandable to its kinds. A kind's
 *  count appears once its table has been opened (custom kinds are not watched otherwise). */
export function CustomSection() {
  const { connected, kinds, loading, error, view, tables, load, showCustom } = useAppStore(
    useShallow((s) => ({
      connected: s.connection.state === "connected", kinds: s.customKinds, loading: s.customKindsLoading, error: s.customKindsError,
      view: s.view, tables: s.customTables, load: s.loadCustomKinds, showCustom: s.showCustom,
    })),
  );
  const [open, setOpen] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (connected && kinds === null && !loading && !error) void load();
  }, [connected, kinds, loading, error, load]);
  const groups = useMemo(() => {
    const byGroup = new Map<string, CustomKind[]>();
    for (const k of kinds ?? []) {
      const g = k.resource.group || "core";
      byGroup.set(g, [...(byGroup.get(g) ?? []), k]);
    }
    return [...byGroup.entries()];
  }, [kinds]);
  if (!connected) return null;

  const activeKey = view.name === "custom" ? refKey(view.resource) : null;
  const toggleGroup = (g: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  const refresh = (
    <button type="button" aria-label="Refresh custom resources" title="Refresh custom resources" disabled={loading}
      onClick={() => void load(true)} className="mr-2 grid size-6 place-items-center rounded-md text-text-muted hover:text-text-hi disabled:opacity-40">
      <RotateCw className="size-3" />
    </button>
  );

  return (
    <SectionGroup section={{ id: "custom", label: "Custom Resources" }} open={open} onToggle={() => setOpen((o) => !o)} action={refresh}>
      {kinds === null && !error && <div className={`${ROW} pl-8 text-text-muted`}>Loading…</div>}
      {error && <div className={`${ROW} pl-8 text-text-muted`} title={error.message}>Custom resources unavailable</div>}
      {kinds !== null && kinds.length === 0 && !error && <div className={`${ROW} pl-8 text-text-muted`}>No custom resources</div>}
      {groups.map(([group, list]) => {
        const groupOpen = openGroups.has(group);
        const Chevron = groupOpen ? ChevronDown : ChevronRight;
        return (
          <div key={group}>
            <button type="button" aria-expanded={groupOpen} onClick={() => toggleGroup(group)} className={`${ROW} pl-6 ${IDLE}`}>
              <Chevron className="size-3 shrink-0" />
              <span className="truncate">{group}</span>
            </button>
            {groupOpen && list.map((k) => {
              const key = refKey(k.resource);
              const count = tables.get(key)?.rows.length;
              return (
                <button key={key} type="button" aria-current={key === activeKey ? "page" : undefined} onClick={() => void showCustom(k.resource)}
                  className={`${ROW} pl-12 ${key === activeKey ? ACTIVE : IDLE}`}>
                  <span className="flex-1 truncate">{k.resource.kind}</span>
                  {" "/* a flex row drops it; it keeps the accessible name "Kind 3" */}
                  {count !== undefined && <span className="text-xs tabular-nums text-text-muted">{count}</span>}
                </button>
              );
            })}
          </div>
        );
      })}
    </SectionGroup>
  );
}
