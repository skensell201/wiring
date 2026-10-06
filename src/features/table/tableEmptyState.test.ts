import { describe, expect, it } from "vitest";
import { tableEmptyState, type TableEmptyInput } from "./tableEmptyState";

const input = (over: Partial<TableEmptyInput> = {}): TableEmptyInput => ({ scope: "shop", denied: false, loaded: true, total: 3, shown: 3, search: "", ...over });

describe("tableEmptyState", () => {
  it("resolves the situations in priority order", () => {
    expect(tableEmptyState(input({ scope: null, denied: true, loaded: false }))).toEqual({ type: "noNamespace" });
    expect(tableEmptyState(input({ denied: true, loaded: false }))).toEqual({ type: "noAccess", scope: "shop" });
    expect(tableEmptyState(input({ loaded: false, total: 0 }))).toEqual({ type: "loading" });
    expect(tableEmptyState(input({ total: 0, shown: 0 }))).toEqual({ type: "empty", scope: "shop" });
    expect(tableEmptyState(input({ shown: 0, search: " web " }))).toEqual({ type: "noMatch", query: "web" });
    expect(tableEmptyState(input())).toBeNull();
  });
});
