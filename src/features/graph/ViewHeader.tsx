import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { kindStats, useAppStore } from "../../app/store";
import type { Kind } from "../../shared/ipc/types";
import { KIND_PLURAL, sectionOf } from "../navigator/kindTree";
import { KindChips } from "./KindChips";

/** Title of the centre pane (the category above it for a table, the kind filter under it for the
 *  graph) plus the Graph | Table switch. */
export function ViewHeader() {
  const { view, nodes, table, namespace, lastTableKind, hiddenKinds, deniedKinds, showGraph, showTable, toggleKind } = useAppStore(
    useShallow((s) => ({
      view: s.view, nodes: s.nodes, table: s.view.name === "table" ? s.tables.get(s.view.kind) : undefined, namespace: s.connection.namespace,
      lastTableKind: s.lastTableKind, hiddenKinds: s.hiddenKinds, deniedKinds: s.deniedKinds,
      showGraph: s.showGraph, showTable: s.showTable, toggleKind: s.toggleKind,
    })),
  );
  const stats = useMemo(() => kindStats(nodes), [nodes]);
  const present = useMemo(() => new Set<Kind>([...nodes.values()].map((n) => n.kind)), [nodes]);

  let title: string, eyebrow: string | null = null, count: number;
  if (view.name === "graph") {
    title = "Overview";
    count = 0;
    for (const s of stats.values()) count += s.count;
  } else {
    title = KIND_PLURAL[view.kind];
    eyebrow = sectionOf(view.kind)?.label ?? null;
    count = table ? table.rows.length : stats.get(view.kind)?.count ?? 0;
  }
  const caption = `${namespace ? `${namespace} · ` : ""}${count} ${count === 1 ? "object" : "objects"}`;
  const tableKind = view.name === "table" ? view.kind : lastTableKind;

  return (
    <div className="flex shrink-0 items-end gap-4 border-b border-border bg-space px-8 pt-5">
      <div className="min-w-0 pb-3">
        {eyebrow && <div className="text-xs text-text-muted">{eyebrow}</div>}
        <div className="flex items-baseline gap-4">
          <h1 className="truncate font-serif text-[36px] font-normal leading-[1.2] tracking-[-0.72px] text-text-hi">{title}</h1>
          <span className="shrink-0 text-sm text-text-muted">{caption}</span>
        </div>
        {view.name === "graph" && (
          <div className="mt-3 pb-1">
            <KindChips hidden={hiddenKinds} denied={deniedKinds} present={present} onToggle={toggleKind} />
          </div>
        )}
      </div>
      <div role="group" aria-label="View" className="ml-auto flex gap-6">
        <Segment active={view.name === "graph"} onClick={showGraph}>Graph</Segment>
        <Segment active={view.name === "table"} disabled={tableKind === null} onClick={() => { if (tableKind) void showTable(tableKind); }}>Table</Segment>
      </div>
    </div>
  );
}

function Segment({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick}
      className={`-mb-px h-12 border-b-2 px-1 text-sm font-medium transition-colors disabled:opacity-40 ${
        active ? "border-supernova text-text-hi" : "border-transparent text-text-muted hover:text-text-hi"
      }`}>
      {children}
    </button>
  );
}
