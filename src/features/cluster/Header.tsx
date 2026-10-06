import mark from "../../assets/mark.svg";
import { LoaderCircle, Plus, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { isMac } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";
import { Dot } from "../../shared/ui/Dot";
import { UpdatePill } from "../update/UpdatePill";
import { ForwardsIndicator } from "../forward/ForwardsIndicator";
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

  // The Navigator normally hosts the macOS traffic lights; its 48 px rail is too narrow for them.
  const inset = isMac && sidebarCollapsed ? "pl-12" : "";

  return (
    <header className={`drag-region flex h-16 shrink-0 items-center gap-3 border-b border-border bg-space/80 px-6 backdrop-blur-md ${inset}`}>
      <span className="mr-3 flex items-center gap-2 text-base font-semibold tracking-[-0.1px] text-text-hi">
        <img src={mark} alt="" width={22} height={22} className="select-none" draggable={false} />
        Wiring
      </span>
      <button type="button" className="no-drag rounded-xl border border-border-strong bg-surface px-4 py-1.5 text-sm font-medium text-text-hi hover:bg-muted" onClick={() => void toggleSidebar()}
        title="Toggle navigator" aria-expanded={!sidebarCollapsed}>
        ⎈ <span>{connection.connecting ?? connection.context ?? "choose cluster"}</span>
        {connection.connecting !== null
          ? <span role="img" aria-label="Connecting" className="ml-2 inline-flex align-middle"><LoaderCircle aria-hidden className="size-3.5 text-text-muted motion-safe:animate-spin" /></span>
          : connection.serverVersion ? <span className="ml-2 text-xs font-normal text-text-muted">{connection.serverVersion}</span> : null}
      </button>
      {session && <NamespacePicker />}
      {session && (
        <Button className="flex items-center gap-1.5" disabled={connection.scope === null} onClick={() => openCreate()}
          title={connection.scope === null ? "Select a namespace first" : "Create an object in this namespace"}>
          <Plus className="size-4" /> Create
        </Button>
      )}
      <div className="no-drag relative ml-auto">
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
    </header>
  );
}
