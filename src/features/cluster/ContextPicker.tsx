import { open } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { settings } from "../../shared/settings";
import { Button } from "../../shared/ui/Button";

export function ContextPicker() {
  const { contexts, pickerOpen, connect, selectNamespace, addKubeconfig, setPickerOpen, busy, current } = useAppStore(
    useShallow((s) => ({
      contexts: s.contexts, pickerOpen: s.pickerOpen, connect: s.connect, selectNamespace: s.selectNamespace,
      addKubeconfig: s.addKubeconfig, setPickerOpen: s.setPickerOpen, busy: s.connection.busy, current: s.connection.context,
    })),
  );
  if (!pickerOpen) return null;

  const pick = async (name: string) => {
    const ctx = contexts.find((c) => c.name === name);
    if (await connect(name)) {
      await settings.set("lastContext", name);
      const namespaces = useAppStore.getState().connection.namespaces;
      const ns = ctx?.namespace ?? (namespaces.length === 1 ? namespaces[0] : null);
      if (ns) {
        await selectNamespace(ns);
        await settings.set("lastNamespace", ns);
      }
      setPickerOpen(false);
    }
  };
  const add = async () => {
    const path = await open({ multiple: false, directory: false, title: "Add kubeconfig file" });
    if (typeof path === "string") await addKubeconfig(path);
  };

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80 backdrop-blur-sm">
      <div className="w-[480px] rounded-card border border-border bg-surface p-6">
        <h2 className="mb-1 text-lg text-text-hi">Choose a cluster</h2>
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
          {current && <Button onClick={() => setPickerOpen(false)}>Cancel</Button>}
        </div>
      </div>
    </div>
  );
}
