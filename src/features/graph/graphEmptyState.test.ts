import { describe, expect, it } from "vitest";
import type { GraphNode, Kind } from "../../shared/ipc/types";
import { graphEmptyState, NAMESPACED_KINDS, type GraphEmptyInput } from "./graphEmptyState";

const n = (name: string, kind: Kind = "Pod"): GraphNode => ({ id: `${kind}/shop/${name}`, kind, namespace: "shop", name, status: "ok", badges: [], group: null });
const input = (over: Partial<GraphEmptyInput> = {}): GraphEmptyInput => ({
  context: "prod", scope: ["shop"], namespaces: ["shop"], canListNamespaces: true, graphReady: true, tooLarge: null,
  deniedKinds: new Set(), partialKinds: new Set(), deniedLoaded: true, nodes: new Map([["Pod/shop/web", n("web")]]), hiddenKinds: new Set(), search: "", ...over,
});
const allDenied = new Set<Kind>(NAMESPACED_KINDS);

describe("graphEmptyState", () => {
  it("leaves a missing connection to the connection pane", () => {
    expect(graphEmptyState(input({ context: null, scope: null }))).toBeNull();
  });

  it("asks for a namespace first, saying when namespaces cannot be listed", () => {
    expect(graphEmptyState(input({ scope: null }))).toEqual({ type: "noNamespace", canListNamespaces: true });
    expect(graphEmptyState(input({ scope: null, canListNamespaces: false }))).toEqual({ type: "noNamespace", canListNamespaces: false });
  });

  it("is loading until the scope's snapshot arrives", () => {
    expect(graphEmptyState(input({ graphReady: false, tooLarge: { nodes: 2000, kinds: [] } }))).toEqual({ type: "loading", scope: "shop" });
  });

  it("puts too large before no access", () => {
    expect(graphEmptyState(input({ tooLarge: { nodes: 1873, kinds: [] }, deniedKinds: allDenied, nodes: new Map() })))
      .toEqual({ type: "tooLarge", count: 1873, scope: "shop" });
  });

  it("says no access when every namespaced kind is denied, before empty", () => {
    expect(graphEmptyState(input({ deniedKinds: allDenied, nodes: new Map() }))).toEqual({ type: "noAccess", scope: "shop" });
    expect(NAMESPACED_KINDS).not.toContain("Node");
    // One readable kind is enough to call it merely empty.
    const someDenied = new Set<Kind>(NAMESPACED_KINDS.filter((k) => k !== "ConfigMap"));
    expect(graphEmptyState(input({ deniedKinds: someDenied, nodes: new Map() }))).toEqual({ type: "empty", scope: "shop", restricted: true });
  });

  it("keeps loading an empty scope until its denied kinds are known", () => {
    expect(graphEmptyState(input({ deniedLoaded: false, nodes: new Map() }))).toEqual({ type: "loading", scope: "shop" });
    expect(graphEmptyState(input({ deniedLoaded: true, deniedKinds: allDenied, nodes: new Map() }))).toEqual({ type: "noAccess", scope: "shop" });
    // Objects on screen need no wait.
    expect(graphEmptyState(input({ deniedLoaded: false }))).toBeNull();
  });

  it("says an empty scope is restricted when some kinds are only partly listed", () => {
    expect(graphEmptyState(input({ partialKinds: new Set(["Pod"]), nodes: new Map() }))).toEqual({ type: "empty", scope: "shop", restricted: true });
  });

  it("labels several namespaces like the header", () => {
    expect(graphEmptyState(input({ scope: ["shop", "blog"], nodes: new Map() }))).toEqual({ type: "empty", scope: "shop, blog", restricted: false });
  });

  it("says all kinds are hidden before search misses", () => {
    expect(graphEmptyState(input({ hiddenKinds: new Set(["Pod"]), search: "zzz" }))).toEqual({ type: "allHidden" });
  });

  it("says nothing matches a search", () => {
    expect(graphEmptyState(input({ search: "  zzz " }))).toEqual({ type: "noMatch", query: "zzz" });
    expect(graphEmptyState(input({ search: "web" }))).toBeNull();
    expect(graphEmptyState(input({ search: "shop/we" }))).toBeNull();
  });

  it("has nothing to say about a graph with visible nodes", () => {
    expect(graphEmptyState(input())).toBeNull();
  });
});
