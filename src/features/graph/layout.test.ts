import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, Kind } from "../../shared/ipc/types";
import { COLUMN_GAP, NODE_HEIGHT, NODE_WIDTH, ROW_GAP, layerOf, layout } from "./layout";

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
    expect(layerOf("ConfigMap")).toBe(5);
    expect(layerOf("PersistentVolume")).toBe(5);
    expect(layerOf("Pod")).toBe(6);
    expect(layerOf("PodGroup")).toBe(6);
  });
});

describe("layout", () => {
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

  it("gives a two-column edge one waypoint centred in the middle column, on a row no real node uses", () => {
    const long = e("Service/p/s", "Pod/p/a", "selects");
    const { positions, waypoints } = layout([service, deployment, pod], [long, e("Deployment/p/d", "Pod/p/a")]);
    const wp = waypoints.get(long.id)!;
    expect(wp).toHaveLength(1);
    expect(wp[0].x).toBe(COL + NODE_WIDTH / 2);
    expect((wp[0].y - NODE_HEIGHT / 2) % ROW).toBe(0); // sits exactly on a row slot
    expect(positions.get("Deployment/p/d")!.y).not.toBe(wp[0].y - NODE_HEIGHT / 2);
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

  it("shares one dummy chain between edges with the same source and target", () => {
    const cm = n("ConfigMap/p/c", "ConfigMap");
    const sa = n("ServiceAccount/p/sa", "ServiceAccount");
    const grp = n("PodGroup/p/g", "PodGroup");
    // Deployment (col 0) → PodGroup (col 2), ConfigMap/ServiceAccount in col 1.
    const mounts = e("Deployment/p/d", "PodGroup/p/g", "mounts");
    const envFrom = e("Deployment/p/d", "PodGroup/p/g", "envFrom");
    const { waypoints } = layout([deployment, cm, sa, grp], [mounts, envFrom, e("ConfigMap/p/c", "PodGroup/p/g", "mounts")]);
    expect(waypoints.get(mounts.id)).toEqual(waypoints.get(envFrom.id));
    // Only one slot was reserved: col 1 holds ConfigMap, ServiceAccount and a single dummy.
    const ys = new Set([...waypoints.values()].map((w) => w[0].y));
    expect(ys.size).toBe(1);
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
