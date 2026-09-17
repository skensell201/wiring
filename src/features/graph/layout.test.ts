import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, Kind } from "../../shared/ipc/types";
import { COLUMN_GAP, NODE_HEIGHT, NODE_WIDTH, ROW_GAP, layerOf, layout } from "./layout";

const n = (id: string, kind: Kind): GraphNode => ({ id, kind, namespace: "p", name: id.split("/").pop()!, status: "ok", badges: [], group: null });
const e = (source: string, target: string): GraphEdge => ({ id: `${source}->${target}:owns`, source, target, relation: "owns" });

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
    const pos = layout(nodes, [e("Service/p/s", "Pod/p/a"), e("Deployment/p/d", "Pod/p/a")]);
    expect(pos.get("Service/p/s")!.x).toBe(0);
    expect(pos.get("Deployment/p/d")!.x).toBe(NODE_WIDTH + COLUMN_GAP);
    expect(pos.get("Pod/p/a")!.x).toBe(2 * (NODE_WIDTH + COLUMN_GAP));
  });

  it("stacks nodes in a column with the row gap", () => {
    const nodes = [n("Pod/p/a", "Pod"), n("Pod/p/b", "Pod")];
    const pos = layout(nodes, []);
    const ys = [pos.get("Pod/p/a")!.y, pos.get("Pod/p/b")!.y].sort((a, b) => a - b);
    expect(ys).toEqual([0, NODE_HEIGHT + ROW_GAP]);
  });

  it("orders a column by the position of its predecessors (barycenter)", () => {
    // Two deployments; the pods of the *second* deployment must sit below the first's pods.
    const nodes = [
      n("Deployment/p/a", "Deployment"), n("Deployment/p/b", "Deployment"),
      n("Pod/p/b1", "Pod"), n("Pod/p/a1", "Pod"), n("Pod/p/b2", "Pod"), n("Pod/p/a2", "Pod"),
    ];
    const edges = [e("Deployment/p/a", "Pod/p/a1"), e("Deployment/p/a", "Pod/p/a2"), e("Deployment/p/b", "Pod/p/b1"), e("Deployment/p/b", "Pod/p/b2")];
    const pos = layout(nodes, edges);
    const y = (id: string) => pos.get(id)!.y;
    expect(Math.max(y("Pod/p/a1"), y("Pod/p/a2"))).toBeLessThan(Math.min(y("Pod/p/b1"), y("Pod/p/b2")));
  });

  it("is deterministic regardless of input order and puts orphans last", () => {
    const nodes = [n("Pod/p/z", "Pod"), n("Pod/p/a", "Pod"), n("Deployment/p/d", "Deployment")];
    const edges = [e("Deployment/p/d", "Pod/p/z")];
    const a = layout(nodes, edges);
    const b = layout([...nodes].reverse(), [...edges]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get("Pod/p/z")!.y).toBeLessThan(a.get("Pod/p/a")!.y); // connected first, orphan last
  });

  it("ignores edges whose endpoints are not laid out", () => {
    const pos = layout([n("Pod/p/a", "Pod")], [e("Deployment/p/gone", "Pod/p/a")]);
    expect(pos.size).toBe(1);
  });
});
