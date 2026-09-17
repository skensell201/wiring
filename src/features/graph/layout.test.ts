import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, Kind } from "../../shared/ipc/types";
import { COLUMN_GAP, DUMMY_HEIGHT, NODE_HEIGHT, NODE_WIDTH, ROW_GAP, layerOf, layout } from "./layout";

const n = (id: string, kind: Kind): GraphNode => ({ id, kind, namespace: "p", name: id.split("/").pop()!, status: "ok", badges: [], group: null });
const e = (source: string, target: string, relation: GraphEdge["relation"] = "owns"): GraphEdge => ({ id: `${source}->${target}:${relation}`, source, target, relation });
const COL = NODE_WIDTH + COLUMN_GAP;
const ROW = NODE_HEIGHT + ROW_GAP;

describe("layerOf", () => {
  it("maps every kind to its spec column", () => {
    expect(layerOf("HorizontalPodAutoscaler")).toBe(0);
    expect(layerOf("Ingress")).toBe(1);
    expect(layerOf("Service")).toBe(2);
    expect(layerOf("Deployment")).toBe(3);
    expect(layerOf("CronJob")).toBe(3);
    expect(layerOf("ReplicaSet")).toBe(4);
    expect(layerOf("Job")).toBe(4);
    expect(layerOf("PersistentVolume")).toBe(4);
    expect(layerOf("ConfigMap")).toBe(5);
    expect(layerOf("PersistentVolumeClaim")).toBe(5);
    expect(layerOf("Pod")).toBe(6);
    expect(layerOf("PodGroup")).toBe(6);
  });
});

describe("layout", () => {
  it("places a PersistentVolume one column before the claim it binds", () => {
    const nodes = [n("PersistentVolume/p/pv", "PersistentVolume"), n("PersistentVolumeClaim/p/pvc", "PersistentVolumeClaim")];
    const pos = layout(nodes, [e("PersistentVolume/p/pv", "PersistentVolumeClaim/p/pvc", "binds")]).positions;
    expect(pos.get("PersistentVolume/p/pv")!.x).toBe(0);
    expect(pos.get("PersistentVolumeClaim/p/pvc")!.x).toBe(COL);
  });

  it("places kinds in columns and collapses empty layers", () => {
    const nodes = [n("Service/p/s", "Service"), n("Deployment/p/d", "Deployment"), n("Pod/p/a", "Pod")];
    const pos = layout(nodes, [e("Service/p/s", "Pod/p/a"), e("Deployment/p/d", "Pod/p/a")]).positions;
    expect(pos.get("Service/p/s")!.x).toBe(0);
    expect(pos.get("Deployment/p/d")!.x).toBe(NODE_WIDTH + COLUMN_GAP);
    expect(pos.get("Pod/p/a")!.x).toBe(2 * (NODE_WIDTH + COLUMN_GAP));
  });

  it("stacks nodes in a column with the row gap", () => {
    const nodes = [n("Pod/p/a", "Pod"), n("Pod/p/b", "Pod")];
    const pos = layout(nodes, []).positions;
    const ys = [pos.get("Pod/p/a")!.y, pos.get("Pod/p/b")!.y].sort((a, b) => a - b);
    expect(ys).toEqual([0, NODE_HEIGHT + ROW_GAP]);
  });

  it("orders a column by the position of its predecessors (barycenter)", () => {
    // Two deployments; deployment a's pods sort alphabetically AFTER deployment b's pods
    // (z* vs m*), so this only passes if barycenter ordering actually drives row order.
    const nodes = [
      n("Deployment/p/a", "Deployment"), n("Deployment/p/b", "Deployment"),
      n("Pod/p/m1", "Pod"), n("Pod/p/z1", "Pod"), n("Pod/p/m2", "Pod"), n("Pod/p/z2", "Pod"),
    ];
    const edges = [e("Deployment/p/a", "Pod/p/z1"), e("Deployment/p/a", "Pod/p/z2"), e("Deployment/p/b", "Pod/p/m1"), e("Deployment/p/b", "Pod/p/m2")];
    const pos = layout(nodes, edges).positions;
    const y = (id: string) => pos.get(id)!.y;
    expect(Math.max(y("Pod/p/z1"), y("Pod/p/z2"))).toBeLessThan(Math.min(y("Pod/p/m1"), y("Pod/p/m2")));
  });

  it("is deterministic regardless of input order and puts orphans last", () => {
    const nodes = [n("Pod/p/z", "Pod"), n("Pod/p/a", "Pod"), n("Deployment/p/d", "Deployment")];
    const edges = [e("Deployment/p/d", "Pod/p/z")];
    const a = layout(nodes, edges).positions;
    const b = layout([...nodes].reverse(), [...edges]).positions;
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get("Pod/p/z")!.y).toBeLessThan(a.get("Pod/p/a")!.y); // connected first, orphan last
  });

  it("ignores edges whose endpoints are not laid out", () => {
    const { positions, waypoints } = layout([n("Pod/p/a", "Pod")], [e("Deployment/p/gone", "Pod/p/a")]);
    expect(positions.size).toBe(1);
    expect(waypoints.size).toBe(0);
  });
});

describe("layout waypoints (dummy slots for edges spanning several columns)", () => {
  // Service (col 0) → Pod (col 2) with a Deployment sitting in col 1. Without a dummy slot the
  // edge would be drawn straight through the Deployment card.
  const service = n("Service/p/s", "Service");
  const deployment = n("Deployment/p/d", "Deployment");
  const pod = n("Pod/p/a", "Pod");

  it("gives a two-column edge one waypoint centred in the middle column, clear of every real card", () => {
    const long = e("Service/p/s", "Pod/p/a", "selects");
    const { positions, waypoints } = layout([service, deployment, pod], [long, e("Deployment/p/d", "Pod/p/a")]);
    const wp = waypoints.get(long.id)!;
    expect(wp).toHaveLength(1);
    expect(wp[0].x).toBe(COL + NODE_WIDTH / 2);
    const d = positions.get("Deployment/p/d")!;
    expect(wp[0].y < d.y || wp[0].y > d.y + NODE_HEIGHT).toBe(true);
  });

  it("uses a thin slot for a dummy, so the real node below it starts at DUMMY_HEIGHT + ROW_GAP", () => {
    const long = e("Service/p/s", "Pod/p/a", "selects");
    const { positions, waypoints } = layout([service, deployment, pod], [long, e("Deployment/p/d", "Pod/p/a")]);
    // Both slots tie on barycenter (both lead to Pod a); dummies sort first.
    expect(waypoints.get(long.id)![0].y).toBe(DUMMY_HEIGHT / 2);
    expect(positions.get("Deployment/p/d")!.y).toBe(DUMMY_HEIGHT + ROW_GAP);
  });

  it("gives every intermediate column its own waypoint", () => {
    const long = e("Service/p/s", "Pod/p/a", "selects");
    const rs = n("ReplicaSet/p/r", "ReplicaSet");
    const { waypoints } = layout([service, deployment, rs, pod], [long]);
    expect(waypoints.get(long.id)!.map((p) => p.x)).toEqual([COL + NODE_WIDTH / 2, 2 * COL + NODE_WIDTH / 2]);
  });

  it("never lets long edges from different sources share a dummy slot", () => {
    const s2 = n("Service/p/t", "Service");
    const a = e("Service/p/s", "Pod/p/a", "selects");
    const b = e("Service/p/t", "Pod/p/a", "selects");
    const { positions, waypoints } = layout([service, s2, deployment, pod], [a, b]);
    const ya = waypoints.get(a.id)![0].y;
    const yb = waypoints.get(b.id)![0].y;
    expect(ya).not.toBe(yb);
    expect(positions.get("Deployment/p/d")!.y + NODE_HEIGHT / 2).not.toBe(ya);
    expect(positions.get("Deployment/p/d")!.y + NODE_HEIGHT / 2).not.toBe(yb);
  });

  it("bundles all long edges from one source into one target column into a single chain", () => {
    const cm = n("ConfigMap/p/c", "ConfigMap");
    const b = n("Pod/p/b", "Pod");
    // Deployment (col 0) → Pod a / Pod b (col 2), ConfigMap in col 1: one shared dummy slot.
    const toA = e("Deployment/p/d", "Pod/p/a");
    const toB = e("Deployment/p/d", "Pod/p/b");
    const again = e("Deployment/p/d", "Pod/p/a", "mounts");
    const { positions, waypoints } = layout([deployment, cm, pod, b], [toA, toB, again, e("ConfigMap/p/c", "Pod/p/a", "mounts")]);
    expect(waypoints.get(toA.id)).toBe(waypoints.get(toB.id));
    expect(waypoints.get(again.id)).toBe(waypoints.get(toA.id));
    expect(waypoints.get(toA.id)).toHaveLength(1);
    // Column 1 holds exactly two slots: the one bundle dummy (its barycenter covers both pods, and
    // Pod b, fed only by the bundle, sorts first) and the ConfigMap right below it.
    expect(waypoints.get(toA.id)![0].y).toBe(DUMMY_HEIGHT / 2);
    expect(positions.get("ConfigMap/p/c")!.y).toBe(DUMMY_HEIGHT + ROW_GAP);
  });

  it("keeps bundles above the real nodes of the column they pass through (blog-like namespace)", () => {
    // Ingress → Service → p1,p2; Deployment → p1,p2; ConfigMap ×2 → p1,p2; ServiceAccount → p1,p2.
    // Columns: Ingress | Service | Deployment | ConfigMap, ConfigMap, SA | Pods. In the fourth column
    // every slot has barycenter 0.5, so only the dummies-first tie-break keeps the bundles from
    // sinking below the ConfigMaps and making the long edges detour to the bottom.
    const nodes = [
      n("Ingress/p/i", "Ingress"), n("Service/p/s", "Service"), n("Deployment/p/d", "Deployment"),
      n("ConfigMap/p/c1", "ConfigMap"), n("ConfigMap/p/c2", "ConfigMap"), n("ServiceAccount/p/sa", "ServiceAccount"),
      n("Pod/p/p1", "Pod"), n("Pod/p/p2", "Pod"),
    ];
    const edges = [
      e("Ingress/p/i", "Service/p/s", "routes"),
      e("Service/p/s", "Pod/p/p1", "selects"), e("Service/p/s", "Pod/p/p2", "selects"),
      e("Deployment/p/d", "Pod/p/p1"), e("Deployment/p/d", "Pod/p/p2"),
      e("ConfigMap/p/c1", "Pod/p/p1", "mounts"), e("ConfigMap/p/c1", "Pod/p/p2", "mounts"),
      e("ConfigMap/p/c2", "Pod/p/p1", "envFrom"), e("ConfigMap/p/c2", "Pod/p/p2", "envFrom"),
      e("ServiceAccount/p/sa", "Pod/p/p1", "usesSA"), e("ServiceAccount/p/sa", "Pod/p/p2", "usesSA"),
    ];
    const { positions, waypoints } = layout(nodes, edges);
    const dep = waypoints.get("Deployment/p/d->Pod/p/p1:owns")!;
    const svc = waypoints.get("Service/p/s->Pod/p/p1:selects")!;
    expect(dep).toBe(waypoints.get("Deployment/p/d->Pod/p/p2:owns"));
    expect(svc).toBe(waypoints.get("Service/p/s->Pod/p/p2:selects"));
    expect(dep).toHaveLength(1);
    expect(svc).toHaveLength(2);

    const col3 = 3 * COL;
    const DUMMY_ROW = DUMMY_HEIGHT + ROW_GAP;
    expect(dep[0].x).toBe(col3 + NODE_WIDTH / 2);
    expect(svc[1].x).toBe(col3 + NODE_WIDTH / 2);
    expect(dep[0].y).toBe(DUMMY_HEIGHT / 2);
    expect(svc[1].y).toBe(DUMMY_ROW + DUMMY_HEIGHT / 2);
    const realYs = ["ConfigMap/p/c1", "ConfigMap/p/c2", "ServiceAccount/p/sa"].map((id) => positions.get(id)!.y).sort((a, b) => a - b);
    expect(realYs).toEqual([2 * DUMMY_ROW, 2 * DUMMY_ROW + ROW, 2 * DUMMY_ROW + 2 * ROW]);
  });

  it("gives edges spanning at most one column no waypoints", () => {
    const short = e("Deployment/p/d", "ReplicaSet/p/r");
    const same = e("PersistentVolume/pv", "PersistentVolumeClaim/p/c", "binds");
    const nodes = [deployment, n("ReplicaSet/p/r", "ReplicaSet"), n("PersistentVolume/pv", "PersistentVolume"), n("PersistentVolumeClaim/p/c", "PersistentVolumeClaim")];
    const { waypoints } = layout(nodes, [short, same]);
    expect(waypoints.has(short.id)).toBe(false);
    expect(waypoints.has(same.id)).toBe(false);
  });

  it("is deterministic for waypoints too", () => {
    const s2 = n("Service/p/t", "Service");
    const edges = [e("Service/p/s", "Pod/p/a", "selects"), e("Service/p/t", "Pod/p/a", "selects"), e("Deployment/p/d", "Pod/p/a")];
    const nodes = [service, s2, deployment, pod];
    const a = layout(nodes, edges);
    const b = layout([...nodes].reverse(), [...edges].reverse());
    expect([...a.positions.entries()].sort()).toEqual([...b.positions.entries()].sort());
    expect([...a.waypoints.entries()].sort()).toEqual([...b.waypoints.entries()].sort());
  });

  it("keeps the dummy on the row between its chain neighbours, not at the bottom of the column", () => {
    // Service s (row 0) → Pod a, Service t (row 1) → Pod b; deployments d1..d3 fill the middle column.
    // Barycenter ordering must interleave the dummies with the deployments rather than dumping them
    // below every real node, otherwise long edges would still dive across the whole column.
    const nodes = [
      service, n("Service/p/t", "Service"),
      n("Deployment/p/d1", "Deployment"), n("Deployment/p/d2", "Deployment"), n("Deployment/p/d3", "Deployment"),
      pod, n("Pod/p/b", "Pod"),
    ];
    const edges = [
      e("Service/p/s", "Pod/p/a", "selects"), e("Service/p/t", "Pod/p/b", "selects"),
      e("Deployment/p/d1", "Pod/p/a"), e("Deployment/p/d2", "Pod/p/a"), e("Deployment/p/d3", "Pod/p/b"),
    ];
    const { positions, waypoints } = layout(nodes, edges);
    const ws = waypoints.get("Service/p/s->Pod/p/a:selects")![0].y;
    const wt = waypoints.get("Service/p/t->Pod/p/b:selects")![0].y;
    expect(ws).toBeLessThan(wt);
    expect(ws).toBeLessThan(positions.get("Deployment/p/d3")!.y);
  });
});
