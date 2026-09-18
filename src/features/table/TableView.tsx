import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { Kind, Status, TableColumn, TableRow } from "../../shared/ipc/types";
import { KIND_PLURAL } from "../navigator/kindTree";
import { filterRows, nextSort, sortRows, type SortState } from "./sort";

const STATUS_TEXT: Record<Status, string> = { ok: "text-status-ok", warn: "text-status-warn", err: "text-status-err", unknown: "text-text-muted" };

/** The per-kind table: sortable, filtered by the header search, keyboard-navigable. */
export function TableView() {
  const { kind, table, search, selectedId, denied, namespace, graphReady, select, focusInGraph } = useAppStore(
    useShallow((s) => {
      const kind = s.view.name === "table" ? s.view.kind : null;
      return {
        kind, table: kind ? s.tables.get(kind) : undefined, search: s.search, selectedId: s.selectedId,
        denied: kind ? s.deniedKinds.has(kind) : false, namespace: s.connection.namespace, graphReady: s.graphReady,
        select: s.select, focusInGraph: s.focusInGraph,
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
  let message: string | null = null;
  if (denied) message = `No access to ${plural} (RBAC)`;
  else if (!namespace) message = "Select a namespace to see its resources.";
  else if (!table || !graphReady) message = `Loading ${plural}…`; // rows are refetched once the snapshot lands
  else if (table.rows.length === 0) message = `No ${plural} in ${namespace}`;
  else if (rows.length === 0) message = `No ${plural} match “${search.trim()}”`;

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
    <div className="h-full w-full overflow-auto bg-void">
      {table && graphReady && !denied && (
        <table ref={grid} role="grid" tabIndex={0} onKeyDown={onKeyDown} aria-label={plural}
          className="w-full border-collapse text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-inset ring-current-b">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr>
              {table.columns.map((c) => <HeaderCell key={c.key} column={c} sort={sort} onClick={() => setSort(nextSort(sort, c.key))} />)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.nodeId} row={r} columns={table.columns} selected={r.nodeId === selectedId}
                onClick={() => void select(r.nodeId)} onDoubleClick={() => void focusInGraph(r.nodeId)} />
            ))}
          </tbody>
        </table>
      )}
      {message && <div className="grid h-full place-items-center text-text-muted">{message}</div>}
    </div>
  );
}

function HeaderCell({ column, sort, onClick }: { column: TableColumn; sort: SortState; onClick: () => void }) {
  const dir = sort?.key === column.key ? sort.dir : null;
  const Arrow = dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <th scope="col" aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
      className={`border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-text-muted ${column.numeric ? "text-right" : "text-left"}`}>
      <button type="button" onClick={onClick} className={`inline-flex items-center gap-1 hover:text-text ${column.numeric ? "flex-row-reverse" : ""}`}>
        {column.label}
        <Arrow className={`size-3 ${dir ? "text-text-hi" : "invisible"}`} />
      </button>
    </th>
  );
}

function Row({ row, columns, selected, onClick, onDoubleClick }: { row: TableRow; columns: TableColumn[]; selected: boolean; onClick: () => void; onDoubleClick: () => void }) {
  return (
    <tr aria-selected={selected} onClick={onClick} onDoubleClick={onDoubleClick} title="Double-click to show in graph"
      className={`cursor-default ${selected ? "bg-muted shadow-[inset_2px_0_0_var(--color-ember-a)]" : "hover:bg-muted/50"}`}>
      {row.cells.map((cell, i) => {
        const numeric = columns[i]?.numeric ?? false;
        return (
          <td key={columns[i]?.key ?? i} data-status={cell.status ?? undefined}
            className={`truncate whitespace-nowrap border-b border-border/50 px-3 py-1.5 ${numeric ? "text-right font-mono" : ""} ${
              cell.status ? STATUS_TEXT[cell.status] : i === 0 ? "text-text-hi" : "text-text"
            }`}>
            {cell.text}
          </td>
        );
      })}
    </tr>
  );
}
