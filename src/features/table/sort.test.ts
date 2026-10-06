import { describe, expect, it } from "vitest";
import type { TableColumn, TableRow } from "../../shared/ipc/types";
import { compareCells, filterRows, nextSort, sortRows } from "./sort";

const columns: TableColumn[] = [
  { key: "name", label: "Name", numeric: false },
  { key: "ready", label: "Ready", numeric: true },
  { key: "age", label: "Age", numeric: true },
];
const row = (name: string, ready: string, age: string, status: "ok" | "err" = "ok"): TableRow => ({
  nodeId: `Pod/p/${name}`, status, cells: [{ text: name, status: null }, { text: ready, status: null }, { text: age, status: null }],
});
const names = (rows: TableRow[]) => rows.map((r) => r.cells[0].text);

describe("compareCells", () => {
  it("orders ages by duration, not text", () => {
    const ages = ["4d", "45s", "3h", "12m"];
    expect([...ages].sort((a, b) => compareCells(a, b, true))).toEqual(["45s", "12m", "3h", "4d"]);
  });

  it("parses the leading number of fractions and counts", () => {
    expect(compareCells("2/3", "3/3", true)).toBeLessThan(0);
    expect(compareCells("14", "9", true)).toBeGreaterThan(0);
    expect(compareCells("1/1", "1/1", true)).toBe(0);
  });

  it("falls back to text when nothing numeric leads", () => {
    expect(compareCells("<none>", "abc", true)).toBeLessThan(0);
    expect(compareCells("b", "a", false)).toBeGreaterThan(0);
  });

  it("puts non-numeric cells after numeric ones in a numeric column", () => {
    expect(compareCells("<none>", "3", true)).toBeGreaterThan(0);
    expect(compareCells("3", "<none>", true)).toBeLessThan(0);
  });
});

describe("sortRows", () => {
  const rows = [row("b", "2/3", "12m"), row("a", "3/3", "45s"), row("c", "1/3", "3h")];

  it("sorts by name ascending when unsorted", () => {
    expect(names(sortRows(rows, columns, null))).toEqual(["a", "b", "c"]);
  });

  it("sorts numerically by a numeric column, both directions", () => {
    expect(names(sortRows(rows, columns, { key: "ready", dir: "asc" }))).toEqual(["c", "b", "a"]);
    expect(names(sortRows(rows, columns, { key: "age", dir: "desc" }))).toEqual(["c", "b", "a"]);
  });

  it("keeps equal keys in name order (stable)", () => {
    const tied = [row("z", "1/1", "5m"), row("m", "1/1", "5m"), row("a", "1/1", "5m")];
    expect(names(sortRows(tied, columns, { key: "ready", dir: "asc" }))).toEqual(["a", "m", "z"]);
    expect(names(sortRows(tied, columns, { key: "ready", dir: "desc" }))).toEqual(["a", "m", "z"]);
  });

  it("keeps blank and non-numeric cells last in both directions", () => {
    const mixed = [row("none", "<none>", "1h"), row("b", "2/3", ""), row("blank", "", "2h"), row("a", "3/3", "5m")];
    expect(names(sortRows(mixed, columns, { key: "ready", dir: "asc" }))).toEqual(["b", "a", "blank", "none"]);
    expect(names(sortRows(mixed, columns, { key: "ready", dir: "desc" }))).toEqual(["a", "b", "blank", "none"]);
    expect(names(sortRows(mixed, columns, { key: "age", dir: "asc" }))).toEqual(["a", "none", "blank", "b"]);
    expect(names(sortRows(mixed, columns, { key: "age", dir: "desc" }))).toEqual(["blank", "none", "a", "b"]);
  });

  it("keeps blank text cells last in both directions", () => {
    const text: TableColumn[] = [{ key: "name", label: "Name", numeric: false }, { key: "node", label: "Node", numeric: false }];
    const rows = [row("x", "", ""), row("y", "worker-2", ""), row("z", "worker-1", "")];
    const nodeCell = (r: TableRow) => ({ ...r, cells: [r.cells[0], r.cells[1]] });
    expect(names(sortRows(rows.map(nodeCell), text, { key: "node", dir: "asc" }))).toEqual(["z", "y", "x"]);
    expect(names(sortRows(rows.map(nodeCell), text, { key: "node", dir: "desc" }))).toEqual(["y", "z", "x"]);
  });

  it("ignores an unknown sort key", () => {
    expect(names(sortRows(rows, columns, { key: "nope", dir: "desc" }))).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const copy = [...rows];
    sortRows(rows, columns, { key: "age", dir: "asc" });
    expect(rows).toEqual(copy);
  });
});

describe("filterRows", () => {
  const rows = [row("web-1", "1/1", "5m"), row("api", "2/2", "3h"), row("db", "0/1", "12m")];

  it("matches a case-insensitive substring over every cell", () => {
    expect(names(filterRows(rows, "WEB"))).toEqual(["web-1"]);
    expect(names(filterRows(rows, "2/2"))).toEqual(["api"]);
    expect(names(filterRows(rows, "1"))).toEqual(["web-1", "db"]);
  });

  it("returns every row for a blank query", () => {
    expect(filterRows(rows, "")).toBe(rows);
    expect(filterRows(rows, "   ")).toBe(rows);
  });
});

describe("nextSort", () => {
  it("cycles asc → desc → none on the same key and restarts on another", () => {
    expect(nextSort(null, "age")).toEqual({ key: "age", dir: "asc" });
    expect(nextSort({ key: "age", dir: "asc" }, "age")).toEqual({ key: "age", dir: "desc" });
    expect(nextSort({ key: "age", dir: "desc" }, "age")).toBeNull();
    expect(nextSort({ key: "age", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
  });

  it("sorts kubectl-top usage cells numerically, empty ones last", () => {
    const cols = [{ key: "name", label: "Name", numeric: false }, { key: "cpu", label: "CPU", numeric: true }, { key: "memory", label: "Memory", numeric: true }];
    const row = (name: string, cpu: string, memory: string) => ({ nodeId: `Pod/p/${name}`, status: "ok" as const, cells: [{ text: name, status: null }, { text: cpu, status: null }, { text: memory, status: null }] });
    const rows = [row("a", "1500m", "1024Mi"), row("b", "120m", "64Mi"), row("c", "—", "—"), row("d", "9m", "512Mi")];
    expect(sortRows(rows, cols, { key: "cpu", dir: "asc" }).map((r) => r.cells[0].text)).toEqual(["d", "b", "a", "c"]);
    expect(sortRows(rows, cols, { key: "cpu", dir: "desc" }).map((r) => r.cells[0].text)).toEqual(["a", "b", "d", "c"]);
    expect(sortRows(rows, cols, { key: "memory", dir: "asc" }).map((r) => r.cells[0].text)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("sortRows with a leading namespace column", () => {
  const cols: TableColumn[] = [{ key: "namespace", label: "Namespace", numeric: false }, ...columns];
  const nrow = (ns: string, name: string): TableRow => ({
    nodeId: `Pod/${ns}/${name}`, status: "ok",
    cells: [ns, name, "1/1", "1m"].map((text) => ({ text, status: null })),
  });
  const rows = [nrow("b", "a"), nrow("a", "z"), nrow("b", "b")];
  const keys = (rs: TableRow[]) => rs.map((r) => `${r.cells[0].text}/${r.cells[1].text}`);

  it("orders by namespace, then name, when unsorted", () => {
    expect(keys(sortRows(rows, cols, null))).toEqual(["a/z", "b/a", "b/b"]);
  });

  it("sorts by namespace with names breaking ties, and the filter matches it", () => {
    expect(keys(sortRows(rows, cols, { key: "namespace", dir: "desc" }))).toEqual(["b/a", "b/b", "a/z"]);
    expect(keys(filterRows(rows, "a"))).toEqual(["b/a", "a/z"]);
    expect(keys(filterRows(rows, "Z"))).toEqual(["a/z"]);
  });
});
