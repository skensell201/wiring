import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import type { RelationFlowEdge } from "./toFlow";

/** SVG ids must not contain characters outside [A-Za-z0-9_-]; edge ids can (e.g. "/", ":"). */
function sanitiseId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

export const RelationEdge = memo(function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const solid = data?.edge.relation === "owns";
  const opacity = data?.dimmed ? 0.15 : data?.highlighted ? 1 : 0.7;
  // A shared gradient uses objectBoundingBox units by default, which collapses to nothing
  // on a zero-height (perfectly horizontal) edge — e.g. same-layer PV→PVC `binds` edges.
  // Each edge gets its own gradient in userSpaceOnUse coordinates instead.
  const gradientId = `edge-grad-${sanitiseId(id)}`;
  return (
    <>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
          <stop offset="0" style={{ stopColor: "var(--color-current-a)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-current-b)" }} />
        </linearGradient>
      </defs>
      <BaseEdge
        path={path}
        style={{
          stroke: `url(#${gradientId})`,
          strokeWidth: data?.highlighted ? 2.5 : 1.5,
          strokeDasharray: solid ? undefined : "6 4",
          opacity,
          transition: "opacity 150ms, stroke-width 150ms",
        }}
      />
    </>
  );
});
