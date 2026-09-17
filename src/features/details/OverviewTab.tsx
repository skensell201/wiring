import { useAppStore } from "../../app/store";
import type { NodeId, ObjectDetails } from "../../shared/ipc/types";
import { KIND_META } from "../graph/kindMeta";

export function OverviewTab({ data }: { data: ObjectDetails }) {
  const nodes = useAppStore((s) => s.nodes);
  const select = useAppStore((s) => s.select);
  const related = data.related.map((id: NodeId) => nodes.get(id)).filter((n) => n !== undefined);
  return (
    <div className="grid h-full grid-cols-[1fr_260px] gap-6 overflow-auto p-4 selectable">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
        {data.summary.map(([k, v], i) => (
          <div key={`${k}-${i}`} className="contents">
            <dt className="text-text-muted">{k}</dt>
            <dd className="break-all text-text-hi">{v || "—"}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">Related</div>
        <ul className="space-y-1">
          {related.map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => void select(n.id)} className="w-full truncate rounded-md bg-muted px-2 py-1 text-left text-xs hover:text-text-hi">
                <span className="text-text-muted">{KIND_META[n.kind].short}</span> {n.name}
              </button>
            </li>
          ))}
          {related.length === 0 && <li className="text-xs text-text-muted">Nothing connected.</li>}
        </ul>
      </div>
    </div>
  );
}
