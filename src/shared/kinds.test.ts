import { describe, expect, it } from "vitest";
import { CLUSTER_SCOPED } from "./kinds";

describe("CLUSTER_SCOPED", () => {
  it("holds the watched kinds that live outside any namespace", () => {
    expect([...CLUSTER_SCOPED].sort()).toEqual(["ClusterRole", "ClusterRoleBinding", "Node", "PersistentVolume"]);
  });
});
