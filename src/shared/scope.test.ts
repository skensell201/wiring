import { describe, expect, it } from "vitest";
import { firstNamespace, inScope, isMulti, restoredScope, scopeLabel } from "./scope";

describe("namespace scope helpers", () => {
  it("restores a remembered scope, or falls back", () => {
    expect(restoredScope("all", ["a", "b"], true, "a")).toBe("all");
    expect(restoredScope("all", ["a"], false, "a")).toEqual(["a"]);
    expect(restoredScope(["b", "gone"], ["a", "b"], true, "a")).toEqual(["b"]);
    expect(restoredScope(["gone"], ["a", "b"], true, "a")).toEqual(["a"]);
    expect(restoredScope(["typed"], [], false, null)).toEqual(["typed"]);
    expect(restoredScope(null, ["a"], true, null)).toBeNull();
  });
  it("labels a scope", () => {
    expect(scopeLabel(null, [])).toBeNull();
    expect(scopeLabel(["shop"], [])).toBe("shop");
    expect(scopeLabel(["shop", "blog"], [])).toBe("shop, blog");
    expect(scopeLabel("all", ["a", "b", "c"])).toBe("All namespaces (3)");
    expect(scopeLabel("all", [])).toBe("All namespaces");
  });
  it("knows when several namespaces are shown", () => {
    expect(isMulti(null)).toBe(false);
    expect(isMulti(["a"])).toBe(false);
    expect(isMulti(["a", "b"])).toBe(true);
    expect(isMulti("all")).toBe(true);
  });
  it("tells whether a namespace is in scope", () => {
    expect(inScope("all", "x")).toBe(true);
    expect(inScope(["a"], "a")).toBe(true);
    expect(inScope(["a"], "b")).toBe(false);
    expect(inScope(null, "a")).toBe(false);
  });
  it("picks a namespace to create in", () => {
    expect(firstNamespace(["b", "a"], ["a", "b"])).toBe("b");
    expect(firstNamespace("all", ["a", "b"])).toBe("a");
    expect(firstNamespace("all", [])).toBeNull();
    expect(firstNamespace(null, ["a"])).toBeNull();
  });
});
