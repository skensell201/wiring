import { describe, expect, it } from "vitest";
import { kindLabel } from "../features/graph/kindMeta";
import { isCustomId, parseCustomId, refKey } from "./customId";

describe("custom ids", () => {
  it("parses namespaced, cluster-scoped and core-group ids", () => {
    expect(parseCustomId("Custom/cert-manager.io/v1/Certificate/shop/web-tls")).toEqual({
      group: "cert-manager.io", version: "v1", kind: "Certificate", namespace: "shop", name: "web-tls",
    });
    expect(parseCustomId("Custom/cert-manager.io/v1/ClusterIssuer//le")?.namespace).toBeNull();
    expect(parseCustomId("Custom//v1/Widget/ns/w")?.group).toBe("");
  });

  it("rejects anything else", () => {
    expect(parseCustomId("Pod/shop/web")).toBeNull();
    expect(parseCustomId("Custom/x.io/v1/Thing/name-only")).toBeNull();
    expect(parseCustomId("Custom/x.io//Thing/ns/n")).toBeNull();
    expect(isCustomId("Custom/x.io/v1/T/ns/n")).toBe(true);
    expect(isCustomId("ConfigMap/ns/Custom")).toBe(false);
  });

  it("labels custom nodes with their own kind", () => {
    expect(kindLabel("Custom/cert-manager.io/v1/Certificate/shop/web-tls", "Custom")).toBe("Certificate");
    expect(kindLabel("Deployment/shop/web", "Deployment")).toBe("Deployment");
  });

  it("keys a resource by group, version and kind", () => {
    expect(refKey({ group: "cert-manager.io", version: "v1", kind: "Certificate" })).toBe("cert-manager.io/v1/Certificate");
  });
});
