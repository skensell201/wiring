import { Plus, RotateCw, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { isMac } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";
import { Dot } from "../../shared/ui/Dot";
import { UpdatePill } from "../update/UpdatePill";
import { ForwardsIndicator } from "../forward/ForwardsIndicator";
import { NAVIGATOR_RAIL_WIDTH, NAVIGATOR_WIDTH } from "../navigator/sizes";
import { Brand } from "./Brand";
import { ClusterPicker } from "./ClusterPicker";
import { NamespacePicker } from "./NamespacePicker";

/** The room the window's traffic lights take in the bar's left corner on macOS. The class name is
 *  a literal: Tailwind finds classes in the source text, not in values built at runtime. */
const MAC_CORNER = "pl-[88px]";

/** What the session is doing, as the bar words it. */
const STATE_TEXT = { connected: "Connected", degraded: "Reconnecting…", disconnected: "Disconnected" } as const;

export function Header() {
  const { connection, search, setSearch, reconnect, openCreate, collapsed } = useAppStore(
    useShallow((s) => ({
      connection: s.connection, search: s.search,
      setSearch: s.setSearch, reconnect: s.reconnect, openCreate: s.openCreate,
      collapsed: s.sidebarCollapsed,
    })),
  );
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // While a connect is in flight the old session (if any) is going away: its namespaces and Create don't apply.
  const session = connection.context !== null && connection.connecting === null;

  // The brand column is as wide as the navigator, and its right border is the divider between the
  // brand and the rest of the bar: the line continues the panel's border below it, so the two
  // never drift apart as the panel collapses to a rail.
  const brandColumn = collapsed
    ? `${NAVIGATOR_RAIL_WIDTH} justify-center`
    : `${NAVIGATOR_WIDTH} gap-2.5 ${isMac ? `${MAC_CORNER} pr-4` : "px-4"}`;

  // A collapsed column is 48 px wide, which the macOS traffic lights do not fit in. There the
  // mark moves into the collapsed rail (the Navigator draws it) and the column stays empty.
  const showBrand = !collapsed || !isMac;

  // The lights reach past the collapsed column on macOS, so the context moves right of them.
  const contextPad = isMac && collapsed ? "pl-9" : "pl-4";

  const state = connection.context ? connection.state : "disconnected";

  return (
    <header className="drag-region flex h-16 shrink-0 items-stretch border-b border-border bg-space/80 backdrop-blur-md">
      <div className={`flex shrink-0 items-center border-r border-border ${brandColumn}`}>
        {showBrand && <Brand collapsed={collapsed} />}
      </div>

      <div className={`flex min-w-0 shrink-0 items-center gap-2 pr-4 ${contextPad}`}>
        <ClusterPicker />
        {session && (
          <>
            <span aria-hidden className="text-text-muted">/</span>
            <NamespacePicker />
          </>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center px-4">
        <div className="no-drag relative w-full max-w-80">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-text-muted" />
          <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search"
            className="h-9 w-full rounded-xl border border-border-strong bg-surface pl-9 pr-16 text-sm text-text-hi outline-none placeholder:text-text-muted focus:border-accent" />
          <kbd className="pointer-events-none absolute right-2 top-1.5 rounded-md border border-border-strong px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 pr-4">
        {session && (
          <Button variant="accent" className="flex h-9 items-center gap-1.5" disabled={connection.scope === null} onClick={() => openCreate()}
            title={connection.scope === null ? "Select a namespace first" : "Create an object in this namespace"}>
            <Plus className="size-4" /> Create
          </Button>
        )}
        <span className="flex items-center gap-2 px-1 text-sm">
          <Dot status={state} />
          <span
            title={state === "degraded" ? "Some resources can't be watched right now; Wiring keeps retrying." : undefined}
            className={state === "connected" ? "text-status-ok" : state === "degraded" ? "text-status-warn" : "text-text-muted"}
          >
            {STATE_TEXT[state]}
          </span>
        </span>
        <UpdatePill />
        <ForwardsIndicator />
        {connection.context && (
          <button type="button" aria-label="Reconnect" title="Reconnect" disabled={connection.busy} onClick={() => void reconnect()}
            className="no-drag grid size-9 place-items-center rounded-xl border border-border-strong text-text-hi hover:bg-surface disabled:opacity-50">
            <RotateCw className="size-4" />
          </button>
        )}
      </div>
    </header>
  );
}
