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
});
