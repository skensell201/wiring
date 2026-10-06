import { useAppStore } from "../../app/store";
import type { NodeId, ObjectDetails } from "../../shared/ipc/types";
import { KIND_META, kindLabel } from "../graph/kindMeta";
import { ProblemBlock } from "./ProblemBlock";

export function OverviewTab({ nodeId, data }: { nodeId: NodeId; data: ObjectDetails }) {
  const nodes = useAppStore((s) => s.nodes);
  const select = useAppStore((s) => s.select);
  const related = data.related.map((id: NodeId) => nodes.get(id)).filter((n) => n !== undefined);
  return (
    <div className="h-full overflow-auto p-6 selectable">
      <ProblemBlock nodeId={nodeId} />
      <div className="grid grid-cols-[1fr_280px] gap-6">
        <dl className="grid content-start grid-cols-[max-content_1fr] gap-x-8 gap-y-2 text-sm">
          {data.summary.map(([k, v], i) => (
            <div key={`${k}-${i}`} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="break-all text-text-hi">{v || "—"}</dd>
            </div>
          ))}
        </dl>
        <div>
          <div className="mb-3 text-xs text-text-muted">Related</div>
          <ul className="space-y-1.5">
            {related.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => void select(n.id)} className="w-full truncate rounded-lg border border-border bg-surface px-3 py-1.5 text-left text-sm text-accent hover:border-accent hover:text-text-hi">
                  <span className="text-text-muted">{n.kind === "Custom" ? kindLabel(n.id, n.kind) : KIND_META[n.kind].short}</span>&nbsp; {n.name}
                </button>
              </li>
            ))}
            {related.length === 0 && <li className="text-xs text-text-muted">Nothing connected.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
