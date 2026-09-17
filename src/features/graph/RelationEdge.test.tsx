import { render } from "@testing-library/react";
import { Position, type EdgeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../../shared/ipc/types";
import { RelationEdge } from "./RelationEdge";
import type { RelationFlowEdge } from "./toFlow";

const edge: GraphEdge = { id: "PersistentVolume/pv-1->PersistentVolumeClaim/p/pvc-1:binds", source: "PersistentVolume/pv-1", target: "PersistentVolumeClaim/p/pvc-1", relation: "binds" };

const props = {
  id: edge.id,
  source: edge.source,
  target: edge.target,
  sourceX: 0,
  sourceY: 10,
  targetX: 100,
  targetY: 10,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  data: { edge, highlighted: false, dimmed: false },
} as EdgeProps<RelationFlowEdge>;

describe("RelationEdge", () => {
  it("renders a per-edge userSpaceOnUse gradient so a horizontal edge still has a visible stroke", () => {
    const { container } = render(
      <svg>
        <RelationEdge {...props} />
      </svg>,
    );
    const gradient = container.querySelector("linearGradient");
    expect(gradient).not.toBeNull();
    expect(gradient).toHaveAttribute("gradientUnits", "userSpaceOnUse");
    expect(gradient!.getAttribute("y1")).toBe(gradient!.getAttribute("y2"));
  });

  it("routes through the waypoints when the layout provides them", () => {
    const long: GraphEdge = { id: "Service/p/s->Pod/p/a:selects", source: "Service/p/s", target: "Pod/p/a", relation: "selects" };
    const { container } = render(
      <svg>
        <RelationEdge
          {...props}
          id={long.id}
          source={long.source}
          target={long.target}
          sourceX={0}
          sourceY={0}
          targetX={400}
          targetY={0}
          data={{ edge: long, highlighted: false, dimmed: false, waypoints: [{ x: 200, y: 120 }] }}
        />
      </svg>,
    );
    const d = container.querySelector("path")!.getAttribute("d")!;
    expect(d.startsWith("M 0 0")).toBe(true);
    expect(d).toContain("200 120");
    expect(d.match(/C /g)).toHaveLength(2);
    expect(d.endsWith("400 0")).toBe(true);
    // The gradient still spans source→target.
    const gradient = container.querySelector("linearGradient")!;
    expect(gradient.getAttribute("x1")).toBe("0");
    expect(gradient.getAttribute("x2")).toBe("400");
  });
});
