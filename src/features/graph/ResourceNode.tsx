import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Puzzle } from "lucide-react";
import { memo } from "react";
import type { GraphNode } from "../../shared/ipc/types";
import { Dot } from "../../shared/ui/Dot";
import { GRADIENT_KINDS, KIND_META, kindLabel } from "./kindMeta";
import { NODE_HEIGHT, NODE_WIDTH } from "./layout";
import type { PathTone, ResourceFlowNode } from "./toFlow";

// Static class names: Tailwind only generates classes it can see in the source.
const PATH_RING: Record<PathTone, string> = {
  err: "border-status-err shadow-[0_0_0_1px_var(--color-status-err)]",
  warn: "border-status-warn shadow-[0_0_0_1px_var(--color-status-warn)]",
};

export function ResourceCard({ node, dimmed, expanded, selected, pathTone }: { node: GraphNode; dimmed: boolean; expanded: boolean; selected: boolean; pathTone?: PathTone }) {
  const meta = KIND_META[node.kind];
  const isGroup = node.kind === "PodGroup";
  const isPod = node.kind === "Pod";
  const isCustom = node.kind === "Custom";
  return (
    <div
      data-testid="resource-card"
      data-dimmed={dimmed}
      title={isGroup ? "Double-click to expand" : undefined}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`flex items-center gap-3 rounded-node border bg-surface px-3 transition-opacity ${
        selected ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]" : pathTone ? PATH_RING[pathTone] : "inset-hairline border-border"
      } ${dimmed ? "opacity-30" : "opacity-100"}`}
    >
      {isPod || isGroup ? (
        <Dot status={node.status} className="size-2.5 shrink-0" />
      ) : isCustom ? (
        <span data-testid="custom-icon" className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-text-hi">
          <Puzzle className="size-3.5" />
        </span>
      ) : (
        <span className={`grid size-7 shrink-0 place-items-center rounded-lg text-[10px] font-semibold text-text-hi ${GRADIENT_KINDS.has(node.kind) ? "gradient-brand" : "bg-muted"}`}>
          {meta.letter}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-text-muted">
          <span>{kindLabel(node.id, node.kind)}</span>
          {!isPod && !isGroup && <Dot status={node.status} className="size-1.5" />}
          {isGroup && expanded && <span>(expanded)</span>}
        </div>
        <div className="truncate text-sm font-medium text-text-hi">{node.name}</div>
        {node.badges.length > 0 && (
          <div className="mt-0.5 flex gap-1 overflow-hidden">
            {node.badges.map((b) => (
              <span key={b} className={`truncate rounded-full px-2 text-[10px] ${node.status === "err" ? "bg-status-err text-text-hi" : "bg-muted text-text"}`}>{b}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const ResourceNode = memo(function ResourceNode({ data, selected }: NodeProps<ResourceFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} className="!size-2 !border-space !bg-accent" />
      <ResourceCard node={data.node} dimmed={data.dimmed} expanded={data.expanded} selected={!!selected} pathTone={data.pathTone} />
      <Handle type="source" position={Position.Right} className="!size-2 !border-space !bg-accent" />
    </>
  );
});
