import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { refKey } from "../../shared/customId";
import { scopeLabel } from "../../shared/scope";
import { Button } from "../../shared/ui/Button";
import { filterRows, nextSort, sortRows, type SortState } from "./sort";
import { HeaderCell, Row } from "./TableView";

/** The table of one custom kind, kept live by `custom_table` events while it is open. No arrow-key
 *  navigation and no Actions menu: a custom resource is deleted from the details panel. */
export function CustomTableView() {
  const { resource, table, error, search, selectedId, scope, namespaces, select, focusInGraph, refreshCustom } = useAppStore(
    useShallow((s) => {
      const resource = s.view.name === "custom" ? s.view.resource : null;
      const key = resource ? refKey(resource) : null;
      return {
        resource, table: key ? s.customTables.get(key) : undefined, error: key ? s.customTableErrors.get(key) ?? null : null,
        search: s.search, selectedId: s.selectedId, scope: s.connection.scope, namespaces: s.connection.namespaces,
        select: s.select, focusInGraph: s.focusInGraph, refreshCustom: s.refreshCustom,
      };
    }),
  );
  const key = resource ? refKey(resource) : null;
  const [sort, setSort] = useState<SortState>(null);
  const [sortKey, setSortKey] = useState<string | null>(key);
  if (sortKey !== key) { // a new kind starts unsorted
    setSortKey(key);
    setSort(null);
  }
  const rows = useMemo(() => (table ? sortRows(filterRows(table.rows, search), table.columns, sort) : []), [table, search, sort]);
  if (!resource) return null;

  // The watch ended for good (RBAC, the kind no longer served…): say why, and offer to list again.
  if (error) {
    return (
      <div className="grid h-full w-full place-items-center bg-space px-8 py-6">
        <div className="flex flex-col items-center gap-3 text-text-muted">
          <div role="alert">{error}</div>
          <Button onClick={() => void refreshCustom(resource)}>Retry</Button>
        </div>
      </div>
    );
  }

  let message: string | null = null;
  if (!scope) message = "Select a namespace to see its resources.";
  else if (!table) message = `Loading ${resource.kind}…`;
  else if (table.rows.length === 0) message = `No ${resource.kind} in ${resource.namespaced ? scopeLabel(scope, namespaces) : "the cluster"}`;
  else if (rows.length === 0) message = `No ${resource.kind} match “${search.trim()}”`;

  return (
    <div className="h-full w-full overflow-auto bg-space px-8 py-6">
      {table && scope && (
        <table role="grid" aria-label={resource.kind}
          className="w-full border-separate border-spacing-0 rounded-card border border-border bg-surface text-sm outline-none">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>{table.columns.map((c) => <HeaderCell key={c.key} column={c} sort={sort} onClick={() => setSort(nextSort(sort, c.key))} />)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.nodeId} row={r} columns={table.columns} selected={r.nodeId === selectedId}
                onClick={() => void select(r.nodeId)} onDoubleClick={() => void focusInGraph(r.nodeId)} onContextMenu={(e) => e.preventDefault()} />
            ))}
          </tbody>
        </table>
      )}
      {message && <div className="grid h-full place-items-center text-text-muted">{message}</div>}
    </div>
  );
}
