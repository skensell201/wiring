import { describe, expect, it } from "vitest";
import { KINDS } from "../../shared/ipc/types";
import { KIND_PLURAL, SECTIONS, sectionOf } from "./kindTree";

describe("kindTree", () => {
  it("places every kind except PodGroup in exactly one section", () => {
    const seen = new Map<string, number>();
    for (const s of SECTIONS) for (const k of s.kinds) seen.set(k, (seen.get(k) ?? 0) + 1);
    for (const k of KINDS) expect(seen.get(k) ?? 0, k).toBe(k === "PodGroup" ? 0 : 1);
  });

  it("finds the section of a kind", () => {
    expect(sectionOf("Secret")?.label).toBe("Config");
    expect(sectionOf("PodGroup")).toBeUndefined();
  });

  it("has a plural label for every kind", () => {
    for (const k of KINDS) expect(KIND_PLURAL[k]).toBeTruthy();
  });
});
