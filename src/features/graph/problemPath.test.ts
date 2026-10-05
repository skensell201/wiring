import { describe, expect, it } from "vitest";
import type { GraphNode, NodeId, Problem } from "../../shared/ipc/types";
import { MAX_PATH, problemPath } from "./problemPath";

const n = (id: NodeId, problem?: Problem): GraphNode => ({ id, kind: "Pod", namespace: "p", name: id, status: problem ? "err" : "ok", badges: [], group: null, ...(problem ? { problem } : {}) });
const p = (cause: NodeId | null): Problem => ({ reason: "r", message: null, cause });
const map = (...nodes: GraphNode[]) => new Map(nodes.map((x) => [x.id, x]));

describe("problemPath", () => {
  it("follows cause to the root", () => {
    expect(problemPath("a", map(n("a", p("b")), n("b", p("c")), n("c", p(null))))).toEqual(["a", "b", "c"]);
  });
  it("is empty for a node without a problem, and stops at a missing or healthy node", () => {
    expect(problemPath("a", map(n("a")))).toEqual([]);
    expect(problemPath("a", map(n("a", p("gone"))))).toEqual(["a"]);
    expect(problemPath("a", map(n("a", p("b")), n("b")))).toEqual(["a"]);
  });
  it("stops at a repeat", () => {
    expect(problemPath("a", map(n("a", p("b")), n("b", p("a"))))).toEqual(["a", "b"]);
  });
  it("caps the chain", () => {
    const chain = Array.from({ length: 12 }, (_, i) => n(`n${i}`, p(i < 11 ? `n${i + 1}` : null)));
    expect(problemPath("n0", map(...chain))).toHaveLength(MAX_PATH);
  });
});
