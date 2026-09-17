import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { KIND_META } from "../graph/kindMeta";
import { EventsTab } from "./EventsTab";
import { OverviewTab } from "./OverviewTab";
import { YamlTab } from "./YamlTab";

type Tab = "overview" | "yaml" | "events";
const MIN = 120, MAX = 600, DEFAULT = 280;

export function DetailsPanel() {
  const { details, node } = useAppStore(useShallow((s) => ({ details: s.details, node: s.selectedId ? s.nodes.get(s.selectedId) : undefined })));
  const [tab, setTab] = useState<Tab>("overview");
  const [height, setHeight] = useState(DEFAULT);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { startY: e.clientY, startH: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [height]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    setHeight(Math.min(MAX, Math.max(MIN, drag.current.startH + (drag.current.startY - e.clientY))));
  }, []);
  const onPointerUp = useCallback(() => { drag.current = null; }, []);

  useEffect(() => { setTab("overview"); }, [details?.nodeId]);

  const tabs: { id: Tab; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "yaml", label: "YAML" }, { id: "events", label: "Events" }];

  return (
    <section className="shrink-0 border-t border-border bg-panel" style={{ height: collapsed ? 36 : height }}>
      <div className="h-1.5 cursor-row-resize hover:bg-current-b/40" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      <div className="flex h-[30px] items-center gap-1 border-b border-border px-2">
        <div role="tablist" className="flex gap-1">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={`rounded-md px-2.5 py-0.5 text-xs ${tab === t.id ? "bg-muted text-text-hi" : "text-text-muted hover:text-text"}`}>
              {t.label}
            </button>
          ))}
        </div>
        {node && (
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="text-text-hi">{node.name}</span>
            <span className="text-text-muted">{KIND_META[node.kind].label}{node.namespace ? ` · ${node.namespace}` : ""}</span>
          </div>
        )}
        <button type="button" className="ml-2 text-xs text-text-muted hover:text-text-hi" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand panel" : "Collapse panel"}>
          {collapsed ? "▴" : "▾"}
        </button>
      </div>
      {!collapsed && (
        <div className="h-[calc(100%-36px)]">
          {!details ? (
            <div className="grid h-full place-items-center text-sm text-text-muted">Select a node to see details</div>
          ) : details.loading || !details.data ? (
            <div className="grid h-full place-items-center text-sm text-text-muted">{details.loading ? "Loading…" : "Details unavailable"}</div>
          ) : tab === "overview" ? (
            <OverviewTab data={details.data} />
          ) : tab === "yaml" ? (
            <YamlTab yaml={details.data.yaml} />
          ) : (
            <EventsTab events={details.events} />
          )}
        </div>
      )}
    </section>
  );
}
