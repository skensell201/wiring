import { Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { Dot } from "../../shared/ui/Dot";
import { connectContext } from "../cluster/connectContext";
import { useAddKubeconfig } from "../cluster/useAddKubeconfig";
import { SectionLabel } from "./SectionLabel";

/** Every kubeconfig context, the connected one marked with the connection dot. */
export function ClustersSection() {
  const { contexts, current, state, busy } = useAppStore(
    useShallow((s) => ({ contexts: s.contexts, current: s.connection.context, state: s.connection.state, busy: s.connection.busy })),
  );
  const add = useAddKubeconfig();
  return (
    <div className="px-2 pt-2">
      <SectionLabel>Clusters</SectionLabel>
      {contexts.map((c) => {
        const active = c.name === current;
        return (
          <button key={c.name} type="button" disabled={busy} onClick={() => void connectContext(c.name)} title={c.cluster}
            className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm disabled:opacity-50 ${
              active ? "inset-hairline bg-surface text-text-hi" : "text-text-dim hover:bg-surface hover:text-text-hi"
            }`}>
            <span className="grid size-2 shrink-0 place-items-center">{active && <Dot status={state} />}</span>
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            {c.cluster !== c.name && <span className="min-w-0 max-w-[40%] shrink-0 truncate text-xs text-text-muted">{c.cluster}</span>}
          </button>
        );
      })}
      <button type="button" onClick={() => void add()} className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-xs text-text-muted hover:bg-surface hover:text-text-hi">
        <Plus className="size-3.5" /> Add kubeconfig…
      </button>
    </div>
  );
}
