import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { kindStats, useAppStore } from "../../app/store";
import { KIND_PLURAL, sectionOf } from "../navigator/kindTree";

/** Breadcrumb for the centre pane plus the Graph | Table switch. */
export function ViewHeader() {
  const { view, nodes, table, lastTableKind, showGraph, showTable } = useAppStore(
    useShallow((s) => ({
      view: s.view, nodes: s.nodes, table: s.view.name === "table" ? s.tables.get(s.view.kind) : undefined,
      lastTableKind: s.lastTableKind, showGraph: s.showGraph, showTable: s.showTable,
    })),
  );
  const stats = useMemo(() => kindStats(nodes), [nodes]);

  let crumb: string;
  if (view.name === "graph") {
    let total = 0;
    for (const s of stats.values()) total += s.count;
    crumb = `Overview · ${total} ${total === 1 ? "object" : "objects"}`;
  } else {
    const count = table ? table.rows.length : stats.get(view.kind)?.count ?? 0;
    const section = sectionOf(view.kind);
    crumb = `${section ? `${section.label} / ` : ""}${KIND_PLURAL[view.kind]} · ${count}`;
  }
  const tableKind = view.name === "table" ? view.kind : lastTableKind;

  return (
    <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-void px-3">
      <span className="truncate text-sm text-text-hi">{crumb}</span>
      <div role="group" aria-label="View" className="ml-auto flex overflow-hidden rounded-lg border border-border text-xs">
        <Segment active={view.name === "graph"} onClick={showGraph}>Graph</Segment>
        <Segment active={view.name === "table"} disabled={tableKind === null} onClick={() => { if (tableKind) void showTable(tableKind); }}>Table</Segment>
      </div>
    </div>
  );
}

function Segment({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick}
      className={`px-3 py-1 transition-colors disabled:opacity-40 ${active ? "bg-muted text-text-hi" : "text-text-muted hover:text-text"}`}>
      {children}
    </button>
  );
}
