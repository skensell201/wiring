import type { TableColumn, TableRow } from "../../shared/ipc/types";

export type SortState = { key: string; dir: "asc" | "desc" } | null;

const AGE_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** The leading number of a cell, as `kubectl` prints them: `14`, `2/3` → 2, `45s`/`12m`/`3h`/`4d` → seconds.
 *  Compound ages (`2d3h`) sum their parts. `null` when the cell does not start with a number. */
function leadingNumber(text: string): number | null {
  const s = text.trim();
  const age = s.match(/^(\d+[smhd])+$/);
  if (age) {
    let total = 0;
    for (const m of s.matchAll(/(\d+)([smhd])/g)) total += Number(m[1]) * AGE_UNITS[m[2]];
    return total;
  }
  const m = s.match(/^-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Ascending comparison of two cells. Numeric columns compare their leading numbers (non-numeric
 *  cells sort last); everything else, and ties, fall back to a locale-aware text comparison. */
export function compareCells(a: string, b: string, numeric: boolean): number {
  if (numeric) {
    const na = leadingNumber(a), nb = leadingNumber(b);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    if (na !== null && nb === null) return -1;
    if (na === null && nb !== null) return 1;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Whether a cell has nothing to sort by: blank, or without a leading number in a numeric column. */
function isEmptyFor(text: string, numeric: boolean): boolean {
  return numeric ? leadingNumber(text) === null : text.trim() === "";
}

/** A new array sorted by `sort` (name order when `sort` is null); rows that compare equal keep name
 *  order. Cells with nothing to sort by (blank, or non-numeric in a numeric column) stay at the
 *  bottom whichever way the column is sorted — flipping the direction should not surface them. */
export function sortRows(rows: TableRow[], columns: TableColumn[], sort: SortState): TableRow[] {
  const nameIdx = Math.max(0, columns.findIndex((c) => c.key === "name"));
  const byName = (x: TableRow, y: TableRow) => compareCells(x.cells[nameIdx]?.text ?? "", y.cells[nameIdx]?.text ?? "", false);
  const idx = sort ? columns.findIndex((c) => c.key === sort.key) : -1;
  if (!sort || idx < 0) return [...rows].sort(byName);
  const numeric = columns[idx].numeric;
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const tx = x.cells[idx]?.text ?? "", ty = y.cells[idx]?.text ?? "";
    const ex = isEmptyFor(tx, numeric), ey = isEmptyFor(ty, numeric);
    if (ex !== ey) return ex ? 1 : -1;
    if (ex) return byName(x, y); // nothing to order the empties by, so their own order never flips
    const c = compareCells(tx, ty, numeric);
    return c !== 0 ? c * sign : byName(x, y);
  });
}

/** Rows with a case-insensitive substring match in any cell; the same array when the query is blank. */
export function filterRows(rows: TableRow[], query: string): TableRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.cells.some((c) => c.text.toLowerCase().includes(q)));
}

/** Header click: none → asc → desc → none on the same key; a different key starts ascending. */
export function nextSort(current: SortState, key: string): SortState {
  if (!current || current.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}
