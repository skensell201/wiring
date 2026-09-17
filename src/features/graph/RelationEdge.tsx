import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import type { RelationFlowEdge } from "./toFlow";

export const EDGE_GRADIENT_ID = "wiring-edge-gradient";

/** Rendered once inside the canvas so every edge can reference the gradient. */
export function EdgeGradientDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        <linearGradient id={EDGE_GRADIENT_ID} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#077ac7" />
          <stop offset="1" stopColor="#6b21ef" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export const RelationEdge = memo(function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const solid = data?.edge.relation === "owns";
  const opacity = data?.dimmed ? 0.15 : data?.highlighted ? 1 : 0.7;
  return (
    <BaseEdge
      path={path}
      style={{
        stroke: `url(#${EDGE_GRADIENT_ID})`,
        strokeWidth: data?.highlighted ? 2.5 : 1.5,
        strokeDasharray: solid ? undefined : "6 4",
        opacity,
        transition: "opacity 150ms, stroke-width 150ms",
      }}
    />
  );
});
