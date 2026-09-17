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
});
