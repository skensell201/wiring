import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import { pathThrough } from "./edgePath";
import type { Relation } from "../../shared/ipc/types";
import type { RelationFlowEdge } from "./toFlow";

/** Ownership is solid; a pod's node dotted; a policy's admitted peers dash-dot; everything else dashed. */
function dashFor(relation: Relation | undefined): string | undefined {
  switch (relation) {
    case "owns": return undefined;
    case "runsOn": return "2 4";
    case "allows": return "8 3 2 3";
    default: return "6 4";
  }
}

export const RelationEdge = memo(function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  // Edges spanning several columns are routed through the dummy slots the layout reserved for
  // them, so they pass through empty rows instead of behind the cards in between.
  const path = data?.waypoints
    ? pathThrough([{ x: sourceX, y: sourceY }, ...data.waypoints, { x: targetX, y: targetY }])
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })[0];
  const tone = data?.pathTone;
  const opacity = tone ? 1 : data?.dimmed ? 0.15 : data?.highlighted ? 1 : 0.7;
  return (
    <BaseEdge
      path={path}
      style={{
        // Iron Edge at rest; the selection's wiring lights up in Lavender Spark; a problem path
        // takes the status colour.
        stroke: tone ? `var(--color-status-${tone})` : data?.highlighted ? "var(--color-accent)" : "var(--color-border-strong)",
        strokeWidth: tone || data?.highlighted ? 2 : 1.5,
        strokeDasharray: dashFor(data?.edge.relation),
        opacity,
        transition: "opacity 150ms, stroke-width 150ms",
      }}
    />
  );
});
