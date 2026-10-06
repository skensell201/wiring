import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { isCreatable } from "../editor/templates";
import { NOT_NAMESPACED } from "../graph/graphEmptyState";
import { scopeLabel } from "../../shared/scope";
import type { Kind, Status, TableColumn, TableRow } from "../../shared/ipc/types";
import { KIND_PLURAL } from "../navigator/kindTree";
import { TableEmpty } from "./TableEmpty";
import { tableEmptyState } from "./tableEmptyState";
import { filterRows, nextSort, sortRows, type SortState } from "./sort";

const STATUS_TEXT: Record<Status, string> = { ok: "text-status-ok", warn: "text-status-warn", err: "text-status-err", unknown: "text-text-muted" };

/** The per-kind table: sortable, filtered by the header search, keyboard-navigable. */
export function TableView() {
  const { kind, table, search, selectedId, denied, deniedLoaded, partial, scope, namespaces, graphReady, includeHelmStorage, setIncludeHelmStorage, select, focusInGraph, openActionsMenu, openCreate } = useAppStore(
    useShallow((s) => {
      const kind = s.view.name === "table" ? s.view.kind : null;
      return {
        kind, table: kind ? s.tables.get(kind) : undefined, search: s.search, selectedId: s.selectedId,
        denied: kind ? s.deniedKinds.has(kind) : false, deniedLoaded: s.deniedLoaded, partial: kind ? s.partialKinds.has(kind) : false, scope: s.connection.scope, namespaces: s.connection.namespaces, graphReady: s.graphReady,
        includeHelmStorage: s.includeHelmStorage, setIncludeHelmStorage: s.setIncludeHelmStorage,
        select: s.select, focusInGraph: s.focusInGraph, openActionsMenu: s.openActionsMenu, openCreate: s.openCreate,
      };
    }),
  );
  const [sort, setSort] = useState<SortState>(null);
  const [sortKind, setSortKind] = useState<Kind | null>(kind);
  if (sortKind !== kind) { // a new kind starts unsorted
    setSortKind(kind);
    setSort(null);
  }
  const rows = useMemo(() => (table ? sortRows(filterRows(table.rows, search), table.columns, sort) : []), [table, search, sort]);

  // A row picked with the arrow keys may sit outside the scrolled area; bring it into view once it
  // renders as selected. A click already happened on a visible row, so it does not scroll.
  const grid = useRef<HTMLTableElement>(null);
  const scrollToSelected = useRef(false);
  useEffect(() => {
    if (!scrollToSelected.current) return;
    scrollToSelected.current = false;
    grid.current?.querySelector<HTMLElement>('tbody tr[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (!kind) return null;
  const plural = KIND_PLURAL[kind];
  // Cluster-scoped kinds do not depend on the namespace, so they never ask for one.
  const clusterScoped = NOT_NAMESPACED.has(kind);
  // Rows are refetched once the scope's snapshot lands; until then a leftover table is not this scope's.
  const ready = !!table && (clusterScoped || graphReady);
  const total = table?.rows.length ?? 0;
  const empty = tableEmptyState({
    scope: clusterScoped ? "The cluster" : scopeLabel(scope, namespaces), denied,
    // An empty table may still turn out to be denied; wait for the RBAC answer.
    loaded: ready && (deniedLoaded || total > 0), total, shown: rows.length, search,
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      if (selectedId) { e.preventDefault(); void focusInGraph(selectedId); }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const idx = rows.findIndex((r) => r.nodeId === selectedId);
    const next = idx < 0 ? (e.key === "ArrowDown" ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, idx + (e.key === "ArrowDown" ? 1 : -1)));
    if (rows[next] && rows[next].nodeId !== selectedId) {
      scrollToSelected.current = true;
      void select(rows[next].nodeId);
    }
  };

  return (
    <div className="h-full w-full overflow-auto bg-space px-8 py-6">
      {kind === "Secret" && !denied && (
        <label className="mb-3 flex w-fit items-center gap-2 text-xs text-text-muted">
          <input type="checkbox" checked={includeHelmStorage} onChange={(e) => void setIncludeHelmStorage(e.target.checked)} className="accent-accent focus-visible:ring-1 focus-visible:ring-accent" />
          Show Helm storage
        </label>
      )}
      {partial && !denied && scope && (
        <p className="mb-3 text-xs text-text-muted">Some namespaces are missing: no access (RBAC).</p>
      )}
      {ready && !denied && (
        <table ref={grid} role="grid" tabIndex={0} onKeyDown={onKeyDown} aria-label={plural}
          className="w-full border-separate border-spacing-0 rounded-card border border-border bg-surface text-sm outline-none focus-visible:ring-1 focus-visible:ring-accent">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              {table.columns.map((c) => <HeaderCell key={c.key} column={c} sort={sort} onClick={() => setSort(nextSort(sort, c.key))} />)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.nodeId} row={r} columns={table.columns} selected={r.nodeId === selectedId}
                onClick={() => void select(r.nodeId)} onDoubleClick={() => void focusInGraph(r.nodeId)}
                onContextMenu={(e) => { e.preventDefault(); openActionsMenu(r.nodeId, e.clientX, e.clientY); }} />
            ))}
          </tbody>
        </table>
      )}
      {empty && (
        <TableEmpty state={empty} noun={plural} onCreate={isCreatable(kind) ? () => openCreate() : undefined}
          noAccessBody={clusterScoped ? `You can't list ${plural} on this cluster (RBAC). Ask your cluster admin.` : undefined} />
      )}
    </div>
  );
}

export function HeaderCell({ column, sort, onClick }: { column: TableColumn; sort: SortState; onClick: () => void }) {
  const dir = sort?.key === column.key ? sort.dir : null;
  const Arrow = dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <th scope="col" aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
      className={`h-11 border-b border-border px-5 text-xs first:rounded-tl-card last:rounded-tr-card font-medium text-text-muted ${column.numeric ? "text-right" : "text-left"}`}>
      <button type="button" onClick={onClick} className={`inline-flex items-center gap-1 hover:text-text ${column.numeric ? "flex-row-reverse" : ""}`}>
        {column.label}
        <Arrow className={`size-3 ${dir ? "text-text-hi" : "invisible"}`} />
      </button>
    </th>
  );
}

export function Row({ row, columns, selected, onClick, onDoubleClick, onContextMenu }: {
  row: TableRow; columns: TableColumn[]; selected: boolean; onClick: () => void; onDoubleClick: () => void; onContextMenu: (e: MouseEvent) => void;
}) {
  return (
    <tr aria-selected={selected} onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} title="Double-click to show in graph"
      className={`group h-12 cursor-default ${selected ? "bg-muted/50" : "hover:bg-muted/25"}`}>
      {row.cells.map((cell, i) => {
        const numeric = columns[i]?.numeric ?? false;
        return (
          <td key={columns[i]?.key ?? i} data-status={cell.status ?? undefined}
            className={`truncate whitespace-nowrap border-b border-border px-5 group-last:border-b-0 ${selected && i === 0 ? "shadow-[inset_2px_0_0_var(--color-accent)]" : ""} ${numeric ? "text-right tabular-nums" : ""} ${
              cell.status ? STATUS_TEXT[cell.status] : i === 0 ? "text-text-hi" : "text-text"
            }`}>
            {cell.text}
          </td>
        );
      })}
    </tr>
  );
}
