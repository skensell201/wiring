import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../shared/ipc/types";
import { NODE_HEIGHT, NODE_WIDTH } from "./layout";
import { toFlow } from "./toFlow";
import type { Kind } from "../../shared/ipc/types";

const n = (id: string, kind: GraphNode["kind"], name = id.split("/").pop()!): GraphNode => ({ id, kind, namespace: "p", name, status: "ok", badges: [], group: null });
const e = (source: string, target: string, relation: GraphEdge["relation"] = "owns"): GraphEdge => ({ id: `${source}->${target}:${relation}`, source, target, relation });

const nodes = new Map([n("Service/p/web", "Service"), n("Pod/p/a", "Pod"), n("ConfigMap/p/cfg", "ConfigMap")].map((x) => [x.id, x]));
const edges = new Map([e("Service/p/web", "Pod/p/a", "selects"), e("ConfigMap/p/cfg", "Pod/p/a", "envFrom")].map((x) => [x.id, x]));

describe("toFlow", () => {
  it("tints the path in the root cause's colour, like the problem block", () => {
    const dep: GraphNode = { ...n("Deployment/p/bad", "Deployment"), status: "warn", problem: { reason: "1 of 2 not ready", message: null, cause: "Pod/p/bad-1" } };
    const pod: GraphNode = { ...n("Pod/p/bad-1", "Pod"), status: "err", problem: { reason: "CrashLoopBackOff", message: null, cause: null } };
    const owns = e(dep.id, pod.id, "owns");
    const f = toFlow({
      nodes: new Map([dep, pod].map((x) => [x.id, x])), edges: new Map([[owns.id, owns]]),
      hiddenKinds: new Set(), search: "", hoveredId: null, expandedGroups: new Set<string>(), selectedId: dep.id,
    });
    expect(f.nodes.map((x) => x.data.pathTone)).toEqual(["err", "err"]);
    expect(f.edges[0].data.pathTone).toBe("err");
  });

  it("tints the selected node's problem path in its status colour", () => {
    const dep: GraphNode = { ...n("Deployment/p/bad", "Deployment"), status: "warn", problem: { reason: "1 of 1 not ready", message: null, cause: "Pod/p/bad-1" } };
    const pod: GraphNode = { ...n("Pod/p/bad-1", "Pod"), status: "warn", problem: { reason: "ImagePullBackOff", message: null, cause: null } };
    const svc = n("Service/p/bad", "Service");
    const owns = e(dep.id, pod.id, "owns");
    const sel = e(svc.id, pod.id, "selects");
    const input = {
      nodes: new Map([dep, pod, svc].map((x) => [x.id, x])), edges: new Map([owns, sel].map((x) => [x.id, x])),
      hiddenKinds: new Set<GraphNode["kind"]>(), search: "", hoveredId: null, expandedGroups: new Set<string>(),
    };
    const f = toFlow({ ...input, selectedId: dep.id });
    const node = Object.fromEntries(f.nodes.map((x) => [x.id, x.data]));
    const edge = Object.fromEntries(f.edges.map((x) => [x.id, x.data]));
    expect(node[dep.id].pathTone).toBe("warn");
    expect(node[pod.id].pathTone).toBe("warn");
    expect(node[svc.id].pathTone).toBeUndefined();
    expect(edge[owns.id].pathTone).toBe("warn");
    expect(edge[sel.id].pathTone).toBeUndefined();

    const none = toFlow({ ...input, selectedId: svc.id });
    expect(none.edges.every((x) => x.data.pathTone === undefined)).toBe(true);

    // Unchanged nodes keep their data identity; tinted ones are replaced when the tint goes away.
    const other = toFlow({ ...input, selectedId: svc.id });
    expect(other.nodes.find((x) => x.id === svc.id)!.data).toBe(f.nodes.find((x) => x.id === svc.id)!.data);
    expect(other.nodes.find((x) => x.id === pod.id)!.data.pathTone).toBeUndefined();
  });

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

  it("search also matches the namespace, alone or as namespace/name", () => {
    const blogWeb: GraphNode = { ...n("Deployment/blog/web", "Deployment"), namespace: "blog" };
    const shopWeb: GraphNode = { ...n("Deployment/shop/web", "Deployment"), namespace: "shop" };
    const blogDb: GraphNode = { ...n("StatefulSet/blog/db", "StatefulSet"), namespace: "blog" };
    const all = new Map([blogWeb, shopWeb, blogDb].map((x) => [x.id, x]));
    const dimmed = (search: string) => Object.fromEntries(
      toFlow({ nodes: all, edges: new Map(), hiddenKinds: new Set(), search, hoveredId: null, selectedId: null, expandedGroups: new Set() }).nodes.map((x) => [x.id, x.data.dimmed]));
    expect(dimmed("blog")).toEqual({ [blogWeb.id]: false, [shopWeb.id]: true, [blogDb.id]: false });
    expect(dimmed("Blog/Web")).toEqual({ [blogWeb.id]: false, [shopWeb.id]: true, [blogDb.id]: true });
  });

  it("highlights edges touching the hovered node", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(), search: "", hoveredId: "Service/p/web", selectedId: null, expandedGroups: new Set() });
    const byId = Object.fromEntries(f.edges.map((x) => [x.id, x.data]));
    expect(byId["Service/p/web->Pod/p/a:selects"].highlighted).toBe(true);
    expect(byId["ConfigMap/p/cfg->Pod/p/a:envFrom"].highlighted).toBe(false);
  });

  it("ignores a hovered node that is no longer in the graph", () => {
    // Hover A, then a delta removes A: hoveredId is stale until the mouse moves again.
    const a = n("Service/p/a", "Service");
    const b = n("Pod/p/b", "Pod");
    const ab = e(a.id, b.id, "selects");
    const f = toFlow({
      nodes: new Map([[b.id, b]]), edges: new Map([[ab.id, ab]]), hiddenKinds: new Set(), search: "", hoveredId: a.id, selectedId: null, expandedGroups: new Set(),
    });
    expect(f.edges.some((x) => x.data.dimmed)).toBe(false);

    // The same holds with a second, visible edge: nothing gets dimmed by a hover that points nowhere.
    const c = n("ConfigMap/p/c", "ConfigMap");
    const cb = e(c.id, b.id, "envFrom");
    const g = toFlow({
      nodes: new Map([[b.id, b], [c.id, c]]), edges: new Map([[ab.id, ab], [cb.id, cb]]), hiddenKinds: new Set(), search: "", hoveredId: a.id, selectedId: null, expandedGroups: new Set(),
    });
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].data.dimmed).toBe(false);
    expect(g.edges[0].data.highlighted).toBe(false);
  });

  it("sets selection and positions every node", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(), search: "", hoveredId: null, selectedId: "Pod/p/a", expandedGroups: new Set() });
    expect(f.nodes.find((x) => x.id === "Pod/p/a")?.selected).toBe(true);
    expect(f.nodes.every((x) => Number.isFinite(x.position.x) && Number.isFinite(x.position.y))).toBe(true);
    expect(f.nodes.every((x) => x.type === "resource")).toBe(true);
    expect(f.edges.every((x) => x.type === "relation")).toBe(true);
  });

  it("sets explicit dimensions on every node so the MiniMap can measure them before layout", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(), search: "", hoveredId: null, selectedId: null, expandedGroups: new Set() });
    expect(f.nodes.every((x) => x.width === NODE_WIDTH && x.height === NODE_HEIGHT)).toBe(true);
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

      // A second Service into the same pod adds a bundle that sorts first, so this edge's dummy
      // moves down a row: same length, different y → new data object.
      const more = new Map(wNodes);
      const api = n("Service/p/api", "Service");
      more.set(api.id, api);
      const moreEdges = new Map(wEdges);
      const selects = e("Service/p/api", "Pod/p/a", "selects");
      moreEdges.set(selects.id, selects);
      const d = toFlow({ ...input, nodes: more, edges: moreEdges });
      const dById = Object.fromEntries(d.edges.map((x) => [x.id, x.data]));
      expect(dById[long.id].waypoints).toHaveLength(1);
      expect(dById[long.id].waypoints).not.toEqual(aById[long.id].waypoints);
      expect(dById[long.id]).not.toBe(aById[long.id]);
    });
  });

  describe("lanes", () => {
    const base = { hiddenKinds: new Set<Kind>(), search: "", hoveredId: null, selectedId: null, expandedGroups: new Set<string>() };
    const ln = (id: string, kind: Kind, ns: string | null): GraphNode => ({ id, kind, namespace: ns, name: id.split("/").pop()!, status: "ok", badges: [], group: null });
    const multiNodes = new Map([
      ln("Deployment/a/web", "Deployment", "a"),
      ln("Pod/a/web-1", "Pod", "a"),
      ln("Deployment/b/api", "Deployment", "b"),
      ln("PersistentVolumeClaim/b/data", "PersistentVolumeClaim", "b"),
      ln("PersistentVolume//pv", "PersistentVolume", null),
    ].map((x) => [x.id, x]));
    const multiEdges = new Map<string, GraphEdge>([
      ["owns", { id: "owns", source: "Deployment/a/web", target: "Pod/a/web-1", relation: "owns" }],
      ["binds", { id: "binds", source: "PersistentVolume//pv", target: "PersistentVolumeClaim/b/data", relation: "binds" }],
    ]);
    const multi = { ...base, nodes: multiNodes, edges: multiEdges };

    it("lays several namespaces out in lanes, cluster-scoped objects last", () => {
      const flow = toFlow(multi);
      expect(flow.lanes.map((l) => l.data.label)).toEqual(["a", "b", "Cluster-scoped"]);
      expect(flow.lanes.map((l) => l.data.count)).toEqual([2, 2, 1]);
      expect(flow.lanes.map((l) => l.id)).toEqual(["lane:a", "lane:b", "lane:"]);
      const inLane = (id: string, laneId: string) => {
        const node = flow.nodes.find((x) => x.id === id)!;
        const lane = flow.lanes.find((x) => x.id === laneId)!;
        return node.position.y >= lane.position.y && node.position.y + NODE_HEIGHT <= lane.position.y + lane.height!
          && node.position.x >= lane.position.x && node.position.x + NODE_WIDTH <= lane.position.x + lane.width!;
      };
      expect(inLane("Deployment/a/web", "lane:a")).toBe(true);
      expect(inLane("Pod/a/web-1", "lane:a")).toBe(true);
      expect(inLane("Deployment/b/api", "lane:b")).toBe(true);
      expect(inLane("PersistentVolumeClaim/b/data", "lane:b")).toBe(true);
      expect(inLane("PersistentVolume//pv", "lane:")).toBe(true);
      // Lanes are stacked top to bottom without overlapping.
      for (let i = 1; i < flow.lanes.length; i++) {
        expect(flow.lanes[i].position.y).toBeGreaterThan(flow.lanes[i - 1].position.y + flow.lanes[i - 1].height!);
      }
      // The cross-lane edge is still drawn, without waypoints.
      expect(flow.edges.map((x) => x.id).sort()).toEqual(["binds", "owns"]);
      expect(flow.edges.find((x) => x.id === "binds")!.data.waypoints).toBeUndefined();
    });

    it("makes lane frames inert: not selectable, draggable, focusable, nor hit by the pointer, and painted behind", () => {
      const { lanes } = toFlow(multi);
      for (const lane of lanes) {
        expect(lane.type).toBe("lane");
        expect(lane.selectable).toBe(false);
        expect(lane.draggable).toBe(false);
        expect(lane.focusable).toBe(false);
        expect(lane.style?.pointerEvents).toBe("none");
        expect(lane.zIndex).toBeLessThan(0);
      }
    });

    it("counts only visible nodes and drops lanes that filtering empties", () => {
      const flow = toFlow({ ...multi, hiddenKinds: new Set<Kind>(["PersistentVolume", "Pod"]) });
      expect(flow.lanes.map((l) => [l.data.label, l.data.count])).toEqual([["a", 1], ["b", 2]]);
    });

    it("draws no lanes for one namespace, even with cluster-scoped objects", () => {
      expect(toFlow({ ...base, nodes, edges }).lanes).toEqual([]);
      const pv = ln("PersistentVolume//pv", "PersistentVolume", null);
      const withPv = new Map(nodes);
      withPv.set(pv.id, pv);
      expect(toFlow({ ...base, nodes: withPv, edges }).lanes).toEqual([]);
    });

    it("keeps positions and lanes when only a node's status changes", () => {
      const a = toFlow(multi);
      const changed = new Map(multiNodes);
      changed.set("Pod/a/web-1", { ...multiNodes.get("Pod/a/web-1")!, status: "err" });
      const b = toFlow({ ...multi, nodes: changed });
      expect(b.lanes).toBe(a.lanes);
      for (const node of b.nodes) expect(node.position).toBe(a.nodes.find((x) => x.id === node.id)!.position);
      // Unchanged nodes keep their data object.
      expect(b.nodes.find((x) => x.id === "Deployment/b/api")!.data).toBe(a.nodes.find((x) => x.id === "Deployment/b/api")!.data);
    });
  });
});

it("hides custom resource owners and their owns edges with the Custom chip", () => {
  const cr = n("Custom/cert-manager.io/v1/Certificate/p/tls", "Custom");
  const secret = n("Secret/p/tls", "Secret");
  const owns = e(cr.id, secret.id, "owns");
  const input = { nodes: new Map([cr, secret].map((x) => [x.id, x])), edges: new Map([[owns.id, owns]]), search: "", hoveredId: null, expandedGroups: new Set<string>(), selectedId: null };
  expect(toFlow({ ...input, hiddenKinds: new Set<Kind>() }).edges).toHaveLength(1);
  const f = toFlow({ ...input, hiddenKinds: new Set<Kind>(["Custom"]) });
  expect(f.nodes.map((x) => x.id)).toEqual([secret.id]);
  expect(f.edges).toHaveLength(0);
});

describe("release highlight", () => {
  const n = (id: string, kind: GraphNode["kind"]): GraphNode => ({ id, kind, namespace: "shop", name: id.split("/").pop()!, status: "ok", badges: [], group: null });
  const dep = n("Deployment/shop/web", "Deployment");
  const group = n("PodGroup/shop/Deployment/web", "PodGroup");
  const other = n("ConfigMap/shop/other", "ConfigMap");
  const input = {
    nodes: new Map([dep, group, other].map((x) => [x.id, x])), edges: new Map(), hiddenKinds: new Set<GraphNode["kind"]>(), search: "",
    hoveredId: null, selectedId: null, expandedGroups: new Set<string>(),
  };

  it("dims everything outside the release, counting a member's pod group as a member", () => {
    const f = toFlow({ ...input, highlightIds: new Set([dep.id]) });
    const dimmed = Object.fromEntries(f.nodes.map((x) => [x.id, x.data.dimmed]));
    expect(dimmed).toEqual({ [dep.id]: false, [group.id]: false, [other.id]: true });
  });

  it("dims nothing without a highlight", () => {
    expect(toFlow(input).nodes.every((x) => !x.data.dimmed)).toBe(true);
  });
});
