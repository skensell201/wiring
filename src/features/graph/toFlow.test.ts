import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../shared/ipc/types";
import { toFlow } from "./toFlow";

const n = (id: string, kind: GraphNode["kind"], name = id.split("/").pop()!): GraphNode => ({ id, kind, namespace: "p", name, status: "ok", badges: [], group: null });
const e = (source: string, target: string, relation: GraphEdge["relation"] = "owns"): GraphEdge => ({ id: `${source}->${target}:${relation}`, source, target, relation });

const nodes = new Map([n("Service/p/web", "Service"), n("Pod/p/a", "Pod"), n("ConfigMap/p/cfg", "ConfigMap")].map((x) => [x.id, x]));
const edges = new Map([e("Service/p/web", "Pod/p/a", "selects"), e("ConfigMap/p/cfg", "Pod/p/a", "envFrom")].map((x) => [x.id, x]));

describe("toFlow", () => {
  it("hides filtered kinds and their edges", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(["ConfigMap"]), search: "", hoveredId: null, selectedId: null, expandedGroups: new Set() });
    expect(f.nodes.map((x) => x.id).sort()).toEqual(["Pod/p/a", "Service/p/web"]);
    expect(f.edges.map((x) => x.id)).toEqual(["Service/p/web->Pod/p/a:selects"]);
  });

  it("marks search matches and dims the rest", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(), search: "WEB", hoveredId: null, selectedId: null, expandedGroups: new Set() });
    const byId = Object.fromEntries(f.nodes.map((x) => [x.id, x.data]));
    expect(byId["Service/p/web"].dimmed).toBe(false);
    expect(byId["Pod/p/a"].dimmed).toBe(true);
  });

  it("highlights edges touching the hovered node", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(), search: "", hoveredId: "Service/p/web", selectedId: null, expandedGroups: new Set() });
    const byId = Object.fromEntries(f.edges.map((x) => [x.id, x.data]));
    expect(byId["Service/p/web->Pod/p/a:selects"].highlighted).toBe(true);
    expect(byId["ConfigMap/p/cfg->Pod/p/a:envFrom"].highlighted).toBe(false);
  });

  it("sets selection and positions every node", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(), search: "", hoveredId: null, selectedId: "Pod/p/a", expandedGroups: new Set() });
    expect(f.nodes.find((x) => x.id === "Pod/p/a")?.selected).toBe(true);
    expect(f.nodes.every((x) => Number.isFinite(x.position.x) && Number.isFinite(x.position.y))).toBe(true);
    expect(f.nodes.every((x) => x.type === "resource")).toBe(true);
    expect(f.edges.every((x) => x.type === "relation")).toBe(true);
  });
});
