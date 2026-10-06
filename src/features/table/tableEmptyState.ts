export type TableSituation =
  | { type: "noNamespace" }
  | { type: "noAccess"; scope: string }
  | { type: "loading" }
  | { type: "empty"; scope: string }
  | { type: "noMatch"; query: string };

export interface TableEmptyInput {
  /** The scope's label (`scopeLabel`, or "The cluster"), `null` before a namespace is chosen. */
  scope: string | null;
  denied: boolean;
  /** The rows on hand are this scope's. */
  loaded: boolean;
  /** Rows in the scope, before the search filter. */
  total: number;
  /** Rows left after the search filter. */
  shown: number;
  search: string;
}

/** Why a table has no rows to show, in priority order, or `null` when it has some (pure; shared by
 *  the built-in, custom and Helm tables). */
export function tableEmptyState(i: TableEmptyInput): TableSituation | null {
  if (i.scope === null) return { type: "noNamespace" };
  if (i.denied) return { type: "noAccess", scope: i.scope };
  if (!i.loaded) return { type: "loading" };
  if (i.total === 0) return { type: "empty", scope: i.scope };
  if (i.shown === 0) return { type: "noMatch", query: i.search.trim() };
  return null;
}
