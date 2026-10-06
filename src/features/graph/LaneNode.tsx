import type { NodeProps } from "@xyflow/react";
import { memo } from "react";
import { LANE_HEADER, type LaneFlowNode } from "./toFlow";

/** A namespace's frame in a multi-namespace graph. Never interactive: clicks reach the pane, edges and nodes. */
export const LaneNode = memo(function LaneNode({ data, width, height }: NodeProps<LaneFlowNode>) {
  return (
    <div className="pointer-events-none rounded-card border border-border bg-surface/20" style={{ width, height }}>
      <div className="flex items-baseline gap-2 px-6 pt-3" style={{ height: LANE_HEADER }}>
        <span className="text-sm font-medium text-text-hi">{data.label}</span>
        <span className="text-xs text-text-muted">{data.count} {data.count === 1 ? "object" : "objects"}</span>
      </div>
    </div>
  );
});
