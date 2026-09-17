import { describe, expect, it } from "vitest";
import { pathThrough } from "./edgePath";

describe("pathThrough", () => {
  it("starts at the first point, draws one cubic per segment and ends at the last point", () => {
    const d = pathThrough([{ x: 0, y: 10 }, { x: 100, y: 50 }, { x: 200, y: 20 }]);
    expect(d.startsWith("M 0 10")).toBe(true);
    expect(d.match(/C /g)).toHaveLength(2);
    expect(d.endsWith("200 20")).toBe(true);
  });

  it("uses horizontal control points so the curve leaves and enters each point flat", () => {
    const d = pathThrough([{ x: 0, y: 0 }, { x: 100, y: 40 }]);
    // c1 = (0 + 50, 0), c2 = (100 - 50, 40)
    expect(d).toBe("M 0 0 C 50 0, 50 40, 100 40");
  });

  it("degenerates to a move for a single point", () => {
    expect(pathThrough([{ x: 3, y: 4 }])).toBe("M 3 4");
  });
});
