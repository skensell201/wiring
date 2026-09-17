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

  it("reuses node data objects when nothing about the node changed", () => {
    const input = { nodes, edges, hiddenKinds: new Set<GraphNode["kind"]>(), search: "", hoveredId: null, selectedId: null, expandedGroups: new Set<string>() };
    const a = toFlow(input);
    const b = toFlow(input);
    const aById = Object.fromEntries(a.nodes.map((x) => [x.id, x.data]));
    const bById = Object.fromEntries(b.nodes.map((x) => [x.id, x.data]));
    expect(bById["Pod/p/a"]).toBe(aById["Pod/p/a"]);

    const c = toFlow({ ...input, hoveredId: "Service/p/web" });
    const cEdgesById = Object.fromEntries(c.edges.map((x) => [x.id, x.data]));
    const bEdgesById = Object.fromEntries(b.edges.map((x) => [x.id, x.data]));
    expect(cEdgesById["Service/p/web->Pod/p/a:selects"]).not.toBe(bEdgesById["Service/p/web->Pod/p/a:selects"]);
    const cById = Object.fromEntries(c.nodes.map((x) => [x.id, x.data]));
    expect(cById["Pod/p/a"]).toBe(aById["Pod/p/a"]);
  });

  describe("waypoints", () => {
    // Service (col 0) → Pod (col 2) passes the Deployment column, so it gets a waypoint.
    const long = e("Service/p/web", "Pod/p/a", "selects");
    const wNodes = new Map([n("Service/p/web", "Service"), n("Deployment/p/d", "Deployment"), n("Pod/p/a", "Pod")].map((x) => [x.id, x]));
    const wEdges = new Map([long, e("Deployment/p/d", "Pod/p/a")].map((x) => [x.id, x]));
    const input = { nodes: wNodes, edges: wEdges, hiddenKinds: new Set<GraphNode["kind"]>(), search: "", hoveredId: null, selectedId: null, expandedGroups: new Set<string>() };

    it("passes the layout waypoints into edge data and leaves short edges without", () => {
      const f = toFlow(input);
      const byId = Object.fromEntries(f.edges.map((x) => [x.id, x.data]));
      expect(byId[long.id].waypoints).toHaveLength(1);
      expect(byId["Deployment/p/d->Pod/p/a:owns"].waypoints).toBeUndefined();
    });

    it("reuses edge data while the waypoints are unchanged and replaces it when they move", () => {
      const a = toFlow(input);
      const b = toFlow(input);
      const aById = Object.fromEntries(a.edges.map((x) => [x.id, x.data]));
      const bById = Object.fromEntries(b.edges.map((x) => [x.id, x.data]));
      expect(bById[long.id]).toBe(aById[long.id]);

      // Hiding the Deployment collapses its column: the edge is short now and loses its waypoint.
      const c = toFlow({ ...input, hiddenKinds: new Set<GraphNode["kind"]>(["Deployment"]) });
      const cById = Object.fromEntries(c.edges.map((x) => [x.id, x.data]));
      expect(cById[long.id]).not.toBe(aById[long.id]);
      expect(cById[long.id].waypoints).toBeUndefined();

      // Adding a second Deployment moves the dummy row: same length, different y → new data object.
      const more = new Map(wNodes);
      const d2 = n("Deployment/p/a0", "Deployment");
      more.set(d2.id, d2);
      const moreEdges = new Map(wEdges);
      const owns = e("Deployment/p/a0", "Pod/p/a");
      moreEdges.set(owns.id, owns);
      const d = toFlow({ ...input, nodes: more, edges: moreEdges });
      const dById = Object.fromEntries(d.edges.map((x) => [x.id, x.data]));
      expect(dById[long.id].waypoints).toHaveLength(1);
      expect(dById[long.id].waypoints).not.toEqual(aById[long.id].waypoints);
      expect(dById[long.id]).not.toBe(aById[long.id]);
    });
  });
});
