import { describe, expect, it } from "vitest";
import { KINDS } from "../../shared/ipc/types";
import { CREATABLE_KINDS, customTemplate, template } from "./templates";

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

describe("custom resource template", () => {
  it("is apiVersion, kind, metadata and an empty spec", () => {
    const r = { group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", namespaced: true };
    expect(customTemplate(r, "shop")).toBe("apiVersion: cert-manager.io/v1\nkind: Certificate\nmetadata:\n  name: my-certificate\n  namespace: shop\nspec: {}\n");
    expect(customTemplate({ ...r, namespaced: false, kind: "ClusterIssuer" }, "shop")).toBe("apiVersion: cert-manager.io/v1\nkind: ClusterIssuer\nmetadata:\n  name: my-clusterissuer\nspec: {}\n");
    expect(customTemplate({ ...r, group: "" }, null)).toContain("apiVersion: v1\n");
  });
});
