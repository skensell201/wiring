import { ChevronsLeft, ChevronsRight, Plus, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { isMac } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";
import { Dot } from "../../shared/ui/Dot";
import { UpdatePill } from "../update/UpdatePill";
import { ForwardsIndicator } from "../forward/ForwardsIndicator";
import { Brand } from "./Brand";
import { ClusterPicker } from "./ClusterPicker";
import { NamespacePicker } from "./NamespacePicker";

export function Header() {
  const { connection, search, sidebarCollapsed, setSearch, reconnect, toggleSidebar, openCreate } = useAppStore(
    useShallow((s) => ({
      connection: s.connection, search: s.search, sidebarCollapsed: s.sidebarCollapsed,
      setSearch: s.setSearch, reconnect: s.reconnect, toggleSidebar: s.toggleSidebar, openCreate: s.openCreate,
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

  // The brand sits in the middle of the bar, between the session controls and the search.
  // On macOS the window's traffic lights float over the bar's left corner, so the bar leaves
  // room for them.
  const pad = isMac ? "pl-20 pr-6" : "px-6";

  return (
    <header className={`drag-region flex h-16 shrink-0 items-center gap-4 border-b border-border bg-space/80 backdrop-blur-md ${pad}`}>
      {/* Two halves of equal weight around the brand keep it in the middle of the window. */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button type="button" className="no-drag grid size-9 place-items-center rounded-xl border border-border-strong bg-surface text-text-hi hover:bg-muted"
          onClick={() => void toggleSidebar()}
          title={sidebarCollapsed ? "Expand navigator" : "Collapse navigator"} aria-expanded={!sidebarCollapsed}>
          {sidebarCollapsed ? <ChevronsRight aria-hidden className="size-4" /> : <ChevronsLeft aria-hidden className="size-4" />}
        </button>
        <ClusterPicker />
        {session && <NamespacePicker />}
        {session && (
          <Button className="flex items-center gap-1.5" disabled={connection.scope === null} onClick={() => openCreate()}
            title={connection.scope === null ? "Select a namespace first" : "Create an object in this namespace"}>
            <Plus className="size-4" /> Create
          </Button>
        )}
      </div>
      <Brand />
      <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
        <div className="no-drag relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-text-muted" />
          <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search  ${isMac ? "⌘" : "Ctrl+"}K`}
            className="h-9 w-64 rounded-xl border border-border-strong bg-surface pl-9 pr-3 text-sm text-text-hi outline-none placeholder:text-text-muted focus:border-accent" />
        </div>
        <UpdatePill />
        <ForwardsIndicator />
        <Dot status={connection.state} className="mx-1 size-2.5" />
        {connection.context && connection.state === "degraded" && (
          <span className="text-xs text-status-warn" title="Some resources can't be watched right now; Wiring keeps retrying.">Reconnecting…</span>
        )}
        {connection.context && (
          <Button disabled={connection.busy} onClick={() => void reconnect()}>Reconnect</Button>
        )}
      </div>
    </header>
  );
}
