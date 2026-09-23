import mark from "../../assets/mark.svg";
import { Plus, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { isMac } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";
import { Dot } from "../../shared/ui/Dot";
import { NamespacePicker } from "./NamespacePicker";

export function Header() {
  const { connection, search, hasContexts, sidebarCollapsed, setSearch, reconnect, setPickerOpen, toggleSidebar, openCreate } = useAppStore(
    useShallow((s) => ({
      connection: s.connection, search: s.search, hasContexts: s.contexts.length > 0, sidebarCollapsed: s.sidebarCollapsed,
      setSearch: s.setSearch, reconnect: s.reconnect, setPickerOpen: s.setPickerOpen, toggleSidebar: s.toggleSidebar, openCreate: s.openCreate,
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

  // The Navigator normally hosts the macOS traffic lights; its 48 px rail is too narrow for them.
  const inset = isMac && sidebarCollapsed ? "pl-12" : "";
  // Cluster switching lives in the Navigator; the picker stays for the empty state.
  const onContextClick = () => (hasContexts ? void toggleSidebar() : setPickerOpen(true));

  return (
    <header className={`drag-region flex h-16 shrink-0 items-center gap-3 border-b border-border bg-space px-6 ${inset}`}>
      <span className="mr-3 flex items-center gap-2 text-base font-semibold tracking-[-0.1px] text-text-hi">
        <img src={mark} alt="" width={22} height={22} className="select-none" draggable={false} />
        Wiring
      </span>
      <button type="button" className="no-drag rounded-lg border border-border bg-surface px-4 py-1.5 text-sm font-medium text-text-hi hover:bg-muted" onClick={onContextClick}
        title={hasContexts ? "Toggle navigator" : "Choose a cluster"}>
        ⎈ <span>{connection.context ?? "choose cluster"}</span>{connection.serverVersion ? <span className="ml-2 text-xs font-normal text-text-muted">{connection.serverVersion}</span> : null}
      </button>
      {connection.context && <NamespacePicker />}
      {connection.context && (
        <Button className="flex items-center gap-1.5" disabled={connection.namespace === null} onClick={() => openCreate()}
          title={connection.namespace === null ? "Select a namespace first" : "Create an object in this namespace"}>
          <Plus className="size-4" /> Create
        </Button>
      )}
      <div className="no-drag relative ml-auto">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-text-muted" />
        <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search  ${isMac ? "⌘" : "Ctrl+"}K`}
          className="h-9 w-64 rounded-md border border-border bg-void pl-9 pr-3 text-sm text-text-hi outline-none placeholder:text-text-muted focus:border-supernova" />
      </div>
      <Dot status={connection.state} className="mx-1 size-2.5" />
      {connection.context && (
        <Button variant="primary" disabled={connection.busy} onClick={() => void reconnect()}>Reconnect</Button>
      )}
    </header>
  );
}
