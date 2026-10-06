import { describe, expect, it } from "vitest";
import { KINDS } from "../../shared/ipc/types";
import { CREATABLE_KINDS, template } from "./templates";

describe("templates", () => {
  it("covers every watched kind except PodGroup and the cluster-level RBAC objects and Nodes", () => {
    const skipped = ["PodGroup", "Custom", "ClusterRole", "ClusterRoleBinding", "Node"];
    expect(CREATABLE_KINDS).toEqual(KINDS.filter((k) => !skipped.includes(k)));
    expect(CREATABLE_KINDS).not.toContain("Node");
    expect(CREATABLE_KINDS).not.toContain("ClusterRole");
  });

  it.each(["NetworkPolicy", "Role", "RoleBinding"] as const)("%s: namespaced template", (kind) => {
    expect(template(kind, "shop")).toMatch(new RegExp(`kind: ${kind}\\n[\\s\\S]*namespace: shop`));
  });

  it.each(CREATABLE_KINDS)("%s: names the kind, a my- placeholder and the current namespace", (kind) => {
    const yaml = template(kind, "shop");
    expect(yaml).toContain(`kind: ${kind}\n`);
    expect(yaml).toMatch(/^  name: my-/m);
    expect(yaml).toMatch(/^apiVersion: /m);
    if (kind === "PersistentVolume") expect(yaml).not.toContain("namespace");
    else expect(yaml).toContain("  namespace: shop\n");
  });

  it("omits the namespace line when no namespace is selected", () => {
    expect(template("ConfigMap", null)).not.toContain("namespace");
  });

  it("workload templates run the pause image; the Service selects app: my-app", () => {
    for (const kind of ["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"] as const) {
      expect(template(kind, "shop")).toContain("image: registry.k8s.io/pause:3.9");
    }
    expect(template("Service", "shop")).toContain("app: my-app");
    expect(template("Ingress", "shop")).toContain("name: my-service");
  });
});
