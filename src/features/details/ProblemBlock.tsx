import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { K8sEvent, NodeId } from "../../shared/ipc/types";
import { KIND_META } from "../graph/kindMeta";
import { problemPath } from "../graph/problemPath";

const NO_EVENTS: K8sEvent[] = [];
// Static class names: Tailwind only generates classes it can see in the source.
const TONE = {
  err: { box: "border-status-err/40 bg-status-err/10", text: "text-status-err" },
  warn: { box: "border-status-warn/40 bg-status-warn/10", text: "text-status-warn" },
} as const;

/** Why the selected object is yellow or red: the root cause of its problem chain, the chain as
 *  clickable steps, and the newest Warning event when the root has no message of its own. */
export function ProblemBlock({ nodeId }: { nodeId: NodeId }) {
  const { nodes, events, select } = useAppStore(useShallow((s) => ({
    nodes: s.nodes, events: s.details?.nodeId === nodeId ? s.details.events : NO_EVENTS, select: s.select,
  })));
  const node = nodes.get(nodeId);
  if (!node || (node.status !== "err" && node.status !== "warn")) return null;

  const path = problemPath(nodeId, nodes);
  const root = path.length > 0 ? nodes.get(path[path.length - 1])! : node;
  // The Events tab belongs to the selected node: it only explains a root that is that node.
  const warning = root.id === nodeId ? events.find((e) => e.type === "Warning") : undefined;
  const reason = root.problem?.reason ?? warning?.reason;
  if (!reason) return null;
  // The root's own message wins; without one the newest Warning event stands in. When the node
  // has no problem at all, the event's reason is the title and its message the text.
  const own = root.problem?.message ?? null;
  const event = own === null && warning ? (root.problem ? `${warning.reason} — ${warning.message}` : warning.message) : null;
  const tone = root.status === "err" ? TONE.err : TONE.warn;

  return (
    <section role="status" aria-label="Problem" className={`mb-6 rounded-card border px-4 py-3 text-sm ${tone.box}`}>
      <div className={`font-semibold ${tone.text}`}>{reason}</div>
      {own && <div className="mt-1 break-words text-text-hi">{own}</div>}
      {event && <div className="mt-1 break-words text-text-hi">{event}</div>}
      {event && <div className="mt-1 text-xs text-text-muted">from Events</div>}
      {path.length > 1 && (
        <ol aria-label="Path" className="mt-3 flex flex-wrap items-center gap-1.5">
          {path.map((id, i) => {
            const step = nodes.get(id)!;
            return (
              <li key={id} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden className="text-text-muted">→</span>}
                <button type="button" onClick={() => void select(id)}
                  className="rounded-lg border border-border bg-surface px-2 py-0.5 text-xs text-accent hover:border-accent hover:text-text-hi">
                  {`${KIND_META[step.kind].label} ${step.name}`}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
