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
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] disabled:opacity-50 ${
              active ? "bg-muted text-text-hi" : "text-text hover:bg-muted/50"
            }`}>
            <span className="grid size-2 shrink-0 place-items-center">{active && <Dot status={state} />}</span>
            <span className="truncate">{c.name}</span>
            <span className="ml-auto min-w-0 max-w-[45%] truncate text-xs text-text-muted">{c.cluster}</span>
          </button>
        );
      })}
      <button type="button" onClick={() => void add()} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-text-muted hover:bg-muted/50 hover:text-text">
        <Plus className="size-3.5" /> Add kubeconfig…
      </button>
    </div>
  );
}
