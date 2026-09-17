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
      className={`flex items-center gap-2.5 rounded-node border bg-surface px-3 transition-opacity ${
        selected ? "border-transparent shadow-[0_0_0_1.5px_#ff5c2c,0_0_14px_rgba(255,73,44,.35)]" : "border-border"
      } ${dimmed ? "opacity-30" : "opacity-100"}`}
    >
      {isPod || isGroup ? (
        <Dot status={node.status} className="size-2.5 shrink-0" />
      ) : (
        <span className={`grid size-6 shrink-0 place-items-center rounded-md text-[10px] font-semibold text-text-hi ${GRADIENT_KINDS.has(node.kind) ? "gradient-current" : "bg-muted"}`}>
          {meta.letter}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
          <span>{meta.label}</span>
          {!isPod && !isGroup && <Dot status={node.status} className="size-1.5" />}
          {isGroup && expanded && <span className="normal-case tracking-normal">(expanded)</span>}
        </div>
        <div className="truncate text-[13px] text-text-hi">{node.name}</div>
        {node.badges.length > 0 && (
          <div className="mt-0.5 flex gap-1 overflow-hidden">
            {node.badges.map((b) => (
              <span key={b} className={`truncate rounded-full bg-muted px-1.5 text-[10px] ${node.status === "err" ? "text-[#ff492c]" : "text-text"}`}>{b}</span>
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
      <Handle type="target" position={Position.Left} className="!size-2 !border-void !bg-current-b" />
      <ResourceCard node={data.node} dimmed={data.dimmed} expanded={data.expanded} selected={!!selected} />
      <Handle type="source" position={Position.Right} className="!size-2 !border-void !bg-current-b" />
    </>
  );
});
