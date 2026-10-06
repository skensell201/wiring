import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { kindStats, useAppStore } from "../../app/store";
import { refKey } from "../../shared/customId";
import { scopeLabel } from "../../shared/scope";
import type { Kind } from "../../shared/ipc/types";
import { KIND_PLURAL, sectionOf } from "../navigator/kindTree";
import { KindChips } from "./KindChips";

/** Title of the centre pane (the category above it for a table, the kind filter under it for the
 *  graph) plus the Graph | Table switch. */
export function ViewHeader() {
  const { view, nodes, tooLarge, table, customTables, helmReleases, scope, namespaces, lastTableKind, hiddenKinds, deniedKinds, showGraph, showTable, toggleKind, release, highlighted, clearRelease } = useAppStore(
    useShallow((s) => ({
      view: s.view, nodes: s.nodes, tooLarge: s.tooLarge, table: s.view.name === "table" ? s.tables.get(s.view.kind) : undefined,
      customTables: s.customTables, helmReleases: s.helmReleases, scope: s.connection.scope, namespaces: s.connection.namespaces,
      lastTableKind: s.lastTableKind, hiddenKinds: s.hiddenKinds, deniedKinds: s.deniedKinds,
      showGraph: s.showGraph, showTable: s.showTable, toggleKind: s.toggleKind,
      release: s.helmSelected, highlighted: s.highlightIds.size > 0, clearRelease: s.clearRelease,
    })),
  );
  const stats = useMemo(
    () => (tooLarge ? new Map(tooLarge.kinds.map((k) => [k.kind, { count: k.count, worst: k.worst }])) : kindStats(nodes)),
    [nodes, tooLarge],
  );
  const present = useMemo(() => new Set<Kind>([...nodes.values()].map((n) => n.kind)), [nodes]);

  let title: string, eyebrow: string | null = null, count: number;
  if (view.name === "graph") {
    title = "Overview";
    count = 0;
    if (tooLarge) count = tooLarge.nodes;
    else for (const s of stats.values()) count += s.count;
  } else if (view.name === "table") {
    title = KIND_PLURAL[view.kind];
    eyebrow = sectionOf(view.kind)?.label ?? null;
    count = table ? table.rows.length : stats.get(view.kind)?.count ?? 0;
  } else if (view.name === "custom") {
    title = view.resource.kind;
    eyebrow = view.resource.group || "core";
    count = customTables.get(refKey(view.resource))?.rows.length ?? 0;
  } else {
    title = "Releases";
    eyebrow = "Helm";
    count = helmReleases?.length ?? 0;
  }
  const label = scopeLabel(scope, namespaces);
  const caption = `${label ? `${label} · ` : ""}${count} ${count === 1 ? "object" : "objects"}`;
  const tableKind = view.name === "table" ? view.kind : lastTableKind;

  return (
    <div className="flex shrink-0 items-end gap-4 border-b border-border bg-space px-8 pt-5">
      <div className="min-w-0 pb-3">
        {eyebrow && <div className="text-xs font-medium tracking-[0.36px] text-accent">{eyebrow}</div>}
        <div className="flex items-baseline gap-4">
          <h1 className="truncate text-[32px] font-medium leading-[1.15] tracking-[-0.32px] text-text-hi">{title}</h1>
          <span className="shrink-0 text-sm text-text-muted">{caption}</span>
        </div>
        {view.name === "graph" && (
          <div className="mt-3 pb-1">
            <KindChips hidden={hiddenKinds} denied={deniedKinds} present={present} onToggle={toggleKind} />
            {release && highlighted && (
              <div className="mt-2 flex items-center gap-2 text-xs text-text-muted">
                <span>Release <span className="text-text-hi">{release.name}</span> highlighted</span>
                <span aria-hidden>·</span>
                <button type="button" onClick={clearRelease} className="font-medium text-accent hover:text-text-hi">Clear</button>
              </div>
            )}
          </div>
        )}
      </div>
      <div role="group" aria-label="View" className="ml-auto flex gap-6">
        <Segment active={view.name === "graph"} onClick={showGraph}>Graph</Segment>
        {/* Active for every non-graph view; it only switches to a built-in table from the graph or a built-in table. */}
        <Segment active={view.name !== "graph"} disabled={view.name === "graph" && tableKind === null}
          onClick={() => { if ((view.name === "graph" || view.name === "table") && tableKind) void showTable(tableKind); }}>Table</Segment>
      </div>
    </div>
  );
}

function Segment({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick}
      className={`-mb-px h-12 border-b-2 px-1 text-sm font-medium transition-colors disabled:opacity-40 ${
        active ? "border-accent text-text-hi" : "border-transparent text-text-muted hover:text-text-hi"
      }`}>
      {children}
    </button>
  );
}
