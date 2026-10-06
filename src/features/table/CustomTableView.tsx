import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { refKey } from "../../shared/customId";
import { scopeLabel } from "../../shared/scope";
import { CircleAlert } from "lucide-react";
import { EmptyState } from "../../shared/EmptyState";
import { filterRows, nextSort, sortRows, type SortState } from "./sort";
import { TableEmpty } from "./TableEmpty";
import { tableEmptyState } from "./tableEmptyState";
import { HeaderCell, Row } from "./TableView";

/** The table of one custom kind, kept live by `custom_table` events while it is open. No arrow-key
 *  navigation and no Actions menu: a custom resource is deleted from the details panel. `App` keys
 *  it by the kind, so a new kind starts afresh (unsorted). */
export function CustomTableView() {
  const { resource, table, error, search, selectedId, scope, namespaces, nodes, select, focusInGraph, refreshCustom, openCreate } = useAppStore(
    useShallow((s) => {
      const resource = s.view.name === "custom" ? s.view.resource : null;
      const key = resource ? refKey(resource) : null;
      return {
        resource, table: key ? s.customTables.get(key) : undefined, error: key ? s.customTableErrors.get(key) ?? null : null,
        search: s.search, selectedId: s.selectedId, scope: s.connection.scope, namespaces: s.connection.namespaces, nodes: s.nodes,
        select: s.select, focusInGraph: s.focusInGraph, refreshCustom: s.refreshCustom, openCreate: s.openCreate,
      };
    }),
  );
  const [sort, setSort] = useState<SortState>(null);
  const rows = useMemo(() => (table ? sortRows(filterRows(table.rows, search), table.columns, sort) : []), [table, search, sort]);
  if (!resource) return null;

  // The watch ended for good (RBAC, the kind no longer served…): say why, and offer to list again.
  if (error) {
    return (
      <EmptyState icon={CircleAlert} tone="error" title={`Can't list ${resource.kind}`} primary={{ label: "Retry", onClick: () => void refreshCustom(resource) }}>
        {error}
      </EmptyState>
    );
  }

  // A cluster-scoped kind is listed whatever namespaces are selected.
  const label = resource.namespaced ? scopeLabel(scope, namespaces) : "The cluster";
  const empty = tableEmptyState({ scope: label, denied: false, loaded: !!table, total: table?.rows.length ?? 0, shown: rows.length, search });
  const visible = !!table && (scope !== null || !resource.namespaced);

  return (
    <div className="h-full w-full overflow-auto bg-space px-8 py-6">
      {table && visible && (
        <table role="grid" aria-label={resource.kind}
          className="w-full border-separate border-spacing-0 rounded-card border border-border bg-surface text-sm outline-none">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>{table.columns.map((c) => <HeaderCell key={c.key} column={c} sort={sort} onClick={() => setSort(nextSort(sort, c.key))} />)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.nodeId} row={r} columns={table.columns} selected={r.nodeId === selectedId}
                onClick={() => void select(r.nodeId)} onDoubleClick={() => { if (nodes.has(r.nodeId)) void focusInGraph(r.nodeId); }} onContextMenu={(e) => e.preventDefault()} />
            ))}
          </tbody>
        </table>
      )}
      {empty && (
        <div className="h-full">
          <TableEmpty state={empty} noun={resource.plural} scope={resource.namespaced ? "namespaced" : "cluster"} onCreate={() => openCreate()} />
        </div>
      )}
    </div>
  );
}
