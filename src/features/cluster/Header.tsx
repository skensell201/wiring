import { Plus, RotateCw, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { isMac } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";
import { Dot } from "../../shared/ui/Dot";
import { UpdatePill } from "../update/UpdatePill";
import { ForwardsIndicator } from "../forward/ForwardsIndicator";
import { ClusterPicker } from "./ClusterPicker";
import { NamespacePicker } from "./NamespacePicker";

/** The room the window's traffic lights take in the bar's left corner on macOS. It is fixed:
 *  the lights belong to the window, not to the navigator, so nothing moves when the navigator
 *  collapses. The class name is a literal: Tailwind finds classes in the source text, not in
 *  values built at runtime. */
const MAC_CORNER = "pl-[84px]";

/** What the session is doing, as the bar words it. */
const STATE_TEXT = { connected: "Connected", degraded: "Reconnecting…", disconnected: "Disconnected" } as const;

export function Header() {
  const { connection, search, setSearch, reconnect, openCreate } = useAppStore(
    useShallow((s) => ({
      connection: s.connection, search: s.search,
      setSearch: s.setSearch, reconnect: s.reconnect, openCreate: s.openCreate,
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

  const state = connection.context ? connection.state : "disconnected";

  return (
    // The bar spans the whole window and the navigator starts below it, so the panel's right
    // border begins at the bar's bottom line instead of crossing it: a T, not a cross.
    <header className="drag-region flex h-16 shrink-0 items-center border-b border-border bg-space/80 backdrop-blur-md">
      <div className={`flex min-w-0 shrink-0 items-center gap-2 pr-4 ${isMac ? MAC_CORNER : "pl-4"}`}>
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
