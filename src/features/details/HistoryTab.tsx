import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type AppError, type NodeId, type Revision } from "../../shared/ipc/types";
import { Button } from "../../shared/ui/Button";
import { age } from "../actions/age";
import { DiffView } from "../editor/DiffView";

/** At most one refetch per second while a rollout keeps changing the workload. */
const REFRESH_MS = 1000;

function Message({ text }: { text: string }) {
  return <div className="grid h-full place-items-center text-sm text-text-muted">{text}</div>;
}

/** A workload's revisions; picking one shows its pod template diff and offers a rollback to it. */
export function HistoryTab({ nodeId }: { nodeId: NodeId }) {
  const { node, openActionDialog } = useAppStore(useShallow((s) => ({ node: s.nodes.get(nodeId), openActionDialog: s.openActionDialog })));
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const lastLoad = useRef(0);

  // `node` changes identity with every graph update of this workload (a rollout, a scale): refetch then.
  useEffect(() => {
    let active = true;
    const load = () => {
      lastLoad.current = Date.now();
      commands.rolloutHistory(nodeId).then(
        (r) => { if (active) { setRevisions(r); setError(null); } },
        (e) => { if (active) setError(toAppError(e)); },
      );
    };
    const wait = REFRESH_MS - (Date.now() - lastLoad.current);
    if (wait <= 0) {
      load();
      return () => { active = false; };
    }
    const timer = setTimeout(load, wait);
    return () => { active = false; clearTimeout(timer); };
  }, [nodeId, node]);

  if (error?.kind === "forbidden") {
    const source = nodeId.startsWith("Deployment/") ? "replicasets" : "controllerrevisions";
    return <Message text={`No permission to read revision history (${source}).`} />;
  }
  if (error) return <Message text={`Could not load the history: ${error.message}`} />;
  if (!revisions) return <Message text="Loading history…" />;
  if (revisions.length === 0) return <Message text="No revisions recorded." />;

  // Right after a restart or rollback no entry may be marked current yet: the newest one is the base then.
  const base = revisions.find((r) => r.current) ?? revisions[0];
  const selected = revisions.find((r) => r.revision === picked && r.revision !== base.revision) ?? null;
  return (
    <div className="flex h-full min-h-0">
      <ul aria-label="Revisions" className="w-80 shrink-0 overflow-auto border-r border-border">
        {revisions.map((r) => (
          <li key={r.revision}>
            <button type="button" disabled={r.revision === base.revision} aria-pressed={r.revision === selected?.revision} onClick={() => setPicked(r.revision)}
              className={`w-full px-5 py-2.5 text-left text-sm disabled:cursor-default ${r.revision === selected?.revision ? "bg-muted/50" : "enabled:hover:bg-muted/25"}`}>
              <div className="flex items-center gap-2">
                <span className="font-medium text-text-hi">#{r.revision}</span>
                {r.current && <span className="rounded-full bg-accent/20 px-2 text-[10px] text-accent">current</span>}
                <span className="ml-auto text-xs text-text-muted">{age(r.createdAt)}</span>
              </div>
              <div className="truncate text-xs text-text">{r.images.join(", ")}</div>
              {r.changeCause && <div className="truncate text-xs text-text-muted">{r.changeCause}</div>}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
              <span className="text-xs text-text-muted">#{base.revision}{base.current ? " (current)" : ""} → #{selected.revision}</span>
              <Button variant="primary" onClick={() => openActionDialog({ type: "rollback", nodeId, revision: selected.revision })}>
                Rollback to {selected.revision}
              </Button>
            </div>
            <div className="min-h-0 flex-1"><DiffView original={base.template} next={selected.template} /></div>
          </>
        ) : (
          <Message text="Pick a revision to compare it with the current one." />
        )}
      </div>
    </div>
  );
}
