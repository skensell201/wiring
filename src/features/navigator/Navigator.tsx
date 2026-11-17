import { ChevronsLeft, ChevronsRight, RefreshCw, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { commands } from "../../shared/ipc/commands";
import { Dot } from "../../shared/ui/Dot";
import { useUpdateStore } from "../update/updateStore";
import { Brand } from "./Brand";
import { ResourceTree } from "./ResourceTree";
import { SECTIONS, sectionOf } from "./kindTree";
import { SECTION_ICONS } from "./sectionIcons";

const RAIL_BTN = "grid size-8 place-items-center rounded-lg text-text-muted hover:bg-surface hover:text-text-hi";

/** The running app's version, from the bundle. The build-time constant is the fallback, so the
 *  label is there even when the call fails. */
function useAppVersion(): string {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void commands
      .appVersion()
      .then((v) => {
        if (live) setVersion(v);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return version ?? __APP_VERSION__;
}

/** Left sidebar: the brand, the resource tree and a collapse toggle. Collapses to a 48 px icon
 *  rail. The column starts below the title bar, so its right border begins at the bar's bottom
 *  line and never crosses it. */
export function Navigator() {
  const { collapsed, context, state, view, toggleSidebar, showGraph } = useAppStore(
    useShallow((s) => ({
      collapsed: s.sidebarCollapsed, context: s.connection.context, state: s.connection.state, view: s.view,
      toggleSidebar: s.toggleSidebar, showGraph: s.showGraph,
    })),
  );
  const version = useAppVersion();

  if (collapsed) {
    const activeSection = view.name === "table" ? sectionOf(view.kind)?.id : undefined;
    return (
      <aside aria-label="Navigator" className="flex w-12 shrink-0 flex-col border-r border-border bg-void">
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-hidden py-2">
          <div className="mb-1 flex h-8 items-center">
            <Brand collapsed />
          </div>
          <button type="button" title={context ?? "No cluster"} aria-label={context ?? "No cluster"} onClick={() => void toggleSidebar()} className={RAIL_BTN}>
            <Dot status={context ? state : "disconnected"} className="size-2.5" />
          </button>
          <button type="button" title="Overview" aria-label="Overview" aria-current={view.name === "graph" ? "page" : undefined} onClick={showGraph}
            className={`${RAIL_BTN} ${view.name === "graph" ? "inset-hairline bg-surface text-accent" : ""}`}>
            <Waypoints className="size-4" />
          </button>
          {SECTIONS.map((s) => {
            const Icon = SECTION_ICONS[s.id];
            return (
              <button key={s.id} type="button" title={s.label} aria-label={s.label} onClick={() => void toggleSidebar()}
                className={`${RAIL_BTN} ${s.id === activeSection ? "inset-hairline bg-surface text-accent" : ""}`}>
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
    <aside aria-label="Navigator" className="flex w-64 shrink-0 flex-col border-r border-border bg-void">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Brand />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-3 pt-1">
        {context ? <ResourceTree /> : <EmptyZone />}
      </div>
      <RailToggle collapsed={false} version={version} onClick={() => void toggleSidebar()} />
    </aside>
  );
}

/** The navigator's empty space: no cluster yet, so it carries the update check instead of a tree. */
function EmptyZone() {
  return (
    <div className="px-4 pt-6">
      <p className="text-sm text-text-muted">Choose a cluster in the header to browse its resources.</p>
    </div>
  );
}

function RailToggle({ collapsed, version, onClick }: { collapsed: boolean; version?: string; onClick: () => void }) {
  const label = collapsed ? "Expand navigator" : "Collapse navigator";
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  return (
    <div className={`flex shrink-0 items-center gap-2 border-t border-border p-3 ${collapsed ? "justify-center" : "justify-between"}`}>
      {!collapsed && (
        <span className="flex min-w-0 items-center gap-1">
          {version && <span className="truncate text-xs text-text-muted">Version {version}</span>}
          <button type="button" title="Check for updates" aria-label="Check for updates" onClick={() => void useUpdateStore.getState().check(true)}
            className="no-drag grid size-6 shrink-0 place-items-center rounded-md text-text-muted hover:bg-muted hover:text-text-hi">
            <RefreshCw className="size-3.5" />
          </button>
        </span>
      )}
      <button type="button" title={label} aria-label={label} onClick={onClick} className={RAIL_BTN}>
        <Icon className="size-4" />
      </button>
    </div>
  );
}
