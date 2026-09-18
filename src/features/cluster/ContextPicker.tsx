import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { Button } from "../../shared/ui/Button";
import { connectContext } from "./connectContext";
import { useAddKubeconfig } from "./useAddKubeconfig";

export function ContextPicker() {
  const { contexts, pickerOpen, setPickerOpen, busy } = useAppStore(
    useShallow((s) => ({ contexts: s.contexts, pickerOpen: s.pickerOpen, setPickerOpen: s.setPickerOpen, busy: s.connection.busy })),
  );
  const add = useAddKubeconfig();
  // With contexts the Navigator lists them too, so the picker can always be dismissed; without
  // any it is the only way forward (add a kubeconfig) and stays.
  const dismissable = contexts.length > 0;
  useEffect(() => {
    if (!pickerOpen || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // handled here; the global Escape handler must not act on it as well
      setPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen, dismissable, setPickerOpen]);
  if (!pickerOpen) return null;

  const pick = async (name: string) => {
    if (await connectContext(name)) setPickerOpen(false);
  };

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="context-picker-title" className="w-[480px] rounded-card border border-border bg-surface p-6">
        <h2 id="context-picker-title" className="mb-1 text-lg text-text-hi">Choose a cluster</h2>
        <p className="mb-4 text-sm text-text-muted">Contexts from your kubeconfig files.</p>
        {contexts.length === 0 ? (
          <p className="mb-4 text-sm">No kubeconfig contexts found. Add a kubeconfig file, or set <code>KUBECONFIG</code> and restart.</p>
        ) : (
          <ul className="mb-4 max-h-80 overflow-auto">
            {contexts.map((c) => (
              <li key={c.name}>
                <button type="button" disabled={busy} onClick={() => void pick(c.name)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-muted disabled:opacity-50">
                  <span className="text-text-hi">{c.name}</span>
                  <span className="truncate pl-4 text-xs text-text-muted">{c.cluster}{c.namespace ? ` · ${c.namespace}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-between">
          <Button onClick={() => void add()}>Add kubeconfig…</Button>
          {dismissable && <Button onClick={() => setPickerOpen(false)}>Cancel</Button>}
        </div>
      </div>
    </div>
  );
}
