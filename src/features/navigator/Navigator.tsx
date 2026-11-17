import { ChevronsLeft, ChevronsRight, Waypoints } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { commands } from "../../shared/ipc/commands";
import { isMac } from "../../shared/platform";
import { Dot } from "../../shared/ui/Dot";
import { Button } from "../../shared/ui/Button";
import { useUpdateStore } from "../update/updateStore";
import { ResourceTree } from "./ResourceTree";
import { SECTIONS, sectionOf } from "./kindTree";
import { SECTION_ICONS } from "./sectionIcons";
import { NAVIGATOR_RAIL_WIDTH, NAVIGATOR_WIDTH } from "./sizes";
import mark from "../../assets/mark.svg";

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

/** Left sidebar: the resource tree and a collapse toggle. Collapses to a 48 px icon rail. */
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
      <aside aria-label="Navigator" className={`flex ${NAVIGATOR_RAIL_WIDTH} shrink-0 flex-col border-r border-border bg-void`}>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-hidden py-2">
          {/* On macOS the window's traffic lights own the bar's left corner, so the collapsed
              brand column is empty there and the mark sits at the top of the rail instead. */}
          {isMac && (
            <img src={mark} alt="" width={20} height={20} className="mb-1 select-none" draggable={false} />
          )}
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
                className={`${RAIL_BTN} ${s.id === activeSection ? "inset-hairline bg-surface text-text-hi" : ""}`}>
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
    <aside aria-label="Navigator" className={`flex ${NAVIGATOR_WIDTH} shrink-0 flex-col border-r border-border bg-void`}>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-3 pt-2">
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
      <div className="mt-6 border-t border-border pt-4">
        <Button className="px-3 py-1 text-xs" onClick={() => void useUpdateStore.getState().check(true)}>
          Check for updates
        </Button>
      </div>
    </div>
  );
}

function RailToggle({ collapsed, version, onClick }: { collapsed: boolean; version?: string; onClick: () => void }) {
  const label = collapsed ? "Expand navigator" : "Collapse navigator";
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  return (
    <div className={`flex shrink-0 items-center gap-2 border-t border-border p-3 ${collapsed ? "justify-center" : "justify-between"}`}>
      {!collapsed && version && <span className="truncate text-xs text-text-muted">Version {version}</span>}
      <button type="button" title={label} aria-label={label} onClick={onClick} className={RAIL_BTN}>
        <Icon className="size-4" />
      </button>
    </div>
  );
}
