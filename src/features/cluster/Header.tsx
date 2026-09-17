import { Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { Button } from "../../shared/ui/Button";
import { Dot } from "../../shared/ui/Dot";
import { NamespacePicker } from "./NamespacePicker";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform ?? "");

export function Header() {
  const { connection, search, setSearch, reconnect, setPickerOpen } = useAppStore(
    useShallow((s) => ({ connection: s.connection, search: s.search, setSearch: s.setSearch, reconnect: s.reconnect, setPickerOpen: s.setPickerOpen })),
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

  return (
    <header className={`drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border bg-void px-3 ${isMac ? "pl-20" : ""}`}>
      <span className="text-sm font-semibold tracking-wide text-text-hi">Wiring</span>
      <button type="button" className="no-drag rounded-lg border border-border bg-surface px-2.5 py-1 text-sm text-text-hi hover:bg-muted" onClick={() => setPickerOpen(true)}>
        ⎈ <span>{connection.context ?? "choose cluster"}</span>{connection.serverVersion ? <span className="ml-2 text-xs text-text-muted">{connection.serverVersion}</span> : null}
      </button>
      {connection.context && <NamespacePicker />}
      <div className="no-drag relative ml-auto">
        <Search className="pointer-events-none absolute left-2 top-1.5 size-4 text-text-muted" />
        <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search  ${isMac ? "⌘" : "Ctrl+"}K`}
          className="w-56 rounded-lg border border-border bg-surface py-1 pl-8 pr-2 text-sm text-text-hi outline-none focus:border-current-b" />
      </div>
      <Dot status={connection.state} className="size-2.5" />
      {connection.context && (
        <Button variant="primary" disabled={connection.busy} onClick={() => void reconnect()}>Reconnect</Button>
      )}
    </header>
  );
}
