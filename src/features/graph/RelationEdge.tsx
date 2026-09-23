import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import { pathThrough } from "./edgePath";
import type { RelationFlowEdge } from "./toFlow";

export const RelationEdge = memo(function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  // Edges spanning several columns are routed through the dummy slots the layout reserved for
  // them, so they pass through empty rows instead of behind the cards in between.
  const path = data?.waypoints
    ? pathThrough([{ x: sourceX, y: sourceY }, ...data.waypoints, { x: targetX, y: targetY }])
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })[0];
  const solid = data?.edge.relation === "owns";
  const opacity = data?.dimmed ? 0.15 : data?.highlighted ? 1 : 0.7;
  return (
    <BaseEdge
      path={path}
      style={{
        // Asteroid at rest; the selection's wiring lights up in Supernova.
        stroke: data?.highlighted ? "var(--color-supernova)" : "var(--color-text-muted)",
        strokeWidth: data?.highlighted ? 2 : 1.5,
        strokeDasharray: solid ? undefined : "6 4",
        opacity,
        transition: "opacity 150ms, stroke-width 150ms",
      }}
    />
  );
});
