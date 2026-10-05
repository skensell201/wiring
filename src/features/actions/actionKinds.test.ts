import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../shared/ipc/types";
import { actionsFor, desiredReplicas, describeId, hpaFor, kindOf } from "./actionKinds";

const node = (id: string, kind: GraphNode["kind"], badges: string[]): GraphNode => ({
  id, kind, namespace: "p", name: id.split("/").pop()!, status: "ok", badges, group: null,
});

describe("actionKinds", () => {
  it("offers scale, restart and rollback by kind, and delete for everything", () => {
    expect(actionsFor("Deployment")).toEqual(["scale", "restart", "rollback", "forward", "delete"]);
    expect(actionsFor("StatefulSet")).toEqual(["scale", "restart", "rollback", "forward", "delete"]);
    expect(actionsFor("DaemonSet")).toEqual(["restart", "rollback", "forward", "delete"]);
    expect(actionsFor("Pod")).toEqual(["forward", "delete"]);
    expect(actionsFor("Service")).toEqual(["forward", "delete"]);
    expect(actionsFor("PodGroup")).toEqual(["delete"]);
    expect(actionsFor(null)).toEqual(["delete"]);
  });

  it("reads the kind and a label from a node id", () => {
    expect(kindOf("Deployment/p/web")).toBe("Deployment");
    expect(kindOf("Bogus/p/x")).toBeNull();
    expect(describeId("StatefulSet/p/db")).toBe("StatefulSet db");
  });

  it("takes the desired replicas from the ready/desired badge", () => {
    expect(desiredReplicas(node("Deployment/p/web", "Deployment", ["2/3", "nginx:1.27"]))).toBe(3);
    expect(desiredReplicas(node("Deployment/p/web", "Deployment", ["2/3", "rolling 2/3", "nginx:1.27"]))).toBe(3);
    expect(desiredReplicas(node("Deployment/p/web", "Deployment", []))).toBe(1);
    expect(desiredReplicas(undefined)).toBe(1);
  });

  it("finds the HPA that scales a node, with min and max from its badge", () => {
    const hpa = node("HorizontalPodAutoscaler/p/web-hpa", "HorizontalPodAutoscaler", ["2–10", "3"]);
    const edges: GraphEdge[] = [
      { id: "e1", source: hpa.id, target: "Deployment/p/web", relation: "scales" },
      { id: "e2", source: "Service/p/web", target: "Deployment/p/web", relation: "selects" },
    ];
    const nodes = new Map([[hpa.id, hpa]]);
    expect(hpaFor("Deployment/p/web", edges, nodes)).toEqual({ name: "web-hpa", min: 2, max: 10 });
    expect(hpaFor("Deployment/p/api", edges, nodes)).toBeNull();
    // An HPA hidden from the graph still has its edge's id: name only.
    expect(hpaFor("Deployment/p/web", edges, new Map())).toEqual({ name: "web-hpa", min: null, max: null });
  });
});
