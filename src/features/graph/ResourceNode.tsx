import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { GraphNode } from "../../shared/ipc/types";
import { Dot } from "../../shared/ui/Dot";
import { GRADIENT_KINDS, KIND_META } from "./kindMeta";
import { NODE_HEIGHT, NODE_WIDTH } from "./layout";
import type { ResourceFlowNode } from "./toFlow";

export function ResourceCard({ node, dimmed, expanded, selected }: { node: GraphNode; dimmed: boolean; expanded: boolean; selected: boolean }) {
  const meta = KIND_META[node.kind];
  const isGroup = node.kind === "PodGroup";
  const isPod = node.kind === "Pod";
  return (
    <div
      data-testid="resource-card"
      data-dimmed={dimmed}
      title={isGroup ? "Double-click to expand" : undefined}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`flex items-center gap-3 rounded-node border bg-surface px-3 transition-opacity ${
        selected ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]" : "inset-hairline border-border"
      } ${dimmed ? "opacity-30" : "opacity-100"}`}
    >
      {isPod || isGroup ? (
        <Dot status={node.status} className="size-2.5 shrink-0" />
      ) : (
        <span className={`grid size-7 shrink-0 place-items-center rounded-lg text-[10px] font-semibold text-text-hi ${GRADIENT_KINDS.has(node.kind) ? "gradient-brand" : "bg-muted"}`}>
          {meta.letter}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-text-muted">
          <span>{meta.label}</span>
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
      <ResourceCard node={data.node} dimmed={data.dimmed} expanded={data.expanded} selected={!!selected} />
      <Handle type="source" position={Position.Right} className="!size-2 !border-space !bg-accent" />
    </>
  );
});
