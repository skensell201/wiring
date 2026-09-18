import { ChevronsLeft, ChevronsRight, Waypoints } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { isMac } from "../../shared/platform";
import { Dot } from "../../shared/ui/Dot";
import { ClustersSection } from "./ClustersSection";
import { ResourceTree } from "./ResourceTree";
import { SECTIONS, sectionOf } from "./kindTree";
import { SECTION_ICONS } from "./sectionIcons";

const RAIL_BTN = "grid size-8 place-items-center rounded-md text-text-muted hover:bg-muted/50 hover:text-text";

/** Left sidebar: clusters, the resource tree and a collapse toggle. Collapses to a 48 px icon rail. */
export function Navigator() {
  const { collapsed, context, state, view, toggleSidebar, showGraph } = useAppStore(
    useShallow((s) => ({
      collapsed: s.sidebarCollapsed, context: s.connection.context, state: s.connection.state, view: s.view,
      toggleSidebar: s.toggleSidebar, showGraph: s.showGraph,
    })),
  );
  // The top strip lines up with the header; on macOS it is where the traffic lights live.
  const strip = <div className={`drag-region h-12 shrink-0 border-b border-border ${isMac ? "pl-20" : ""}`} />;

  if (collapsed) {
    const activeSection = view.name === "table" ? sectionOf(view.kind)?.id : undefined;
    return (
      <aside aria-label="Navigator" className="flex w-12 shrink-0 flex-col border-r border-border bg-void">
        {strip}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-hidden py-2">
          <button type="button" title={context ?? "No cluster"} aria-label={context ?? "No cluster"} onClick={() => void toggleSidebar()} className={RAIL_BTN}>
            <Dot status={context ? state : "disconnected"} className="size-2.5" />
          </button>
          <button type="button" title="Overview" aria-label="Overview" aria-current={view.name === "graph" ? "page" : undefined} onClick={showGraph}
            className={`${RAIL_BTN} ${view.name === "graph" ? "bg-muted text-text-hi" : ""}`}>
            <Waypoints className="size-4" />
          </button>
          {SECTIONS.map((s) => {
            const Icon = SECTION_ICONS[s.id];
            return (
              <button key={s.id} type="button" title={s.label} aria-label={s.label} onClick={() => void toggleSidebar()}
                className={`${RAIL_BTN} ${s.id === activeSection ? "bg-muted text-text-hi" : ""}`}>
                {Icon ? <Icon className="size-4" /> : s.label[0]}
              </button>
            );
          })}
        </div>
        <RailToggle collapsed onClick={() => void toggleSidebar()} />
      </aside>
    );
  }

  return (
    <aside aria-label="Navigator" className="flex w-60 shrink-0 flex-col border-r border-border bg-void">
      {strip}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <ClustersSection />
        {context ? <ResourceTree /> : <p className="px-4 pt-4 text-xs text-text-muted">Pick a cluster to browse its resources.</p>}
      </div>
      <RailToggle collapsed={false} onClick={() => void toggleSidebar()} />
    </aside>
  );
}

function RailToggle({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const label = collapsed ? "Expand navigator" : "Collapse navigator";
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  return (
    <div className={`flex shrink-0 border-t border-border p-2 ${collapsed ? "justify-center" : "justify-end"}`}>
      <button type="button" title={label} aria-label={label} onClick={onClick} className={RAIL_BTN}>
        <Icon className="size-4" />
      </button>
    </div>
  );
}
