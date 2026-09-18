import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { Button } from "../../shared/ui/Button";
import { KIND_META } from "../graph/kindMeta";
import { LazyYamlEditor } from "./LazyYamlEditor";
import { CREATABLE_KINDS, type CreatableKind } from "./templates";

/** The **+ Create** modal: a kind picker, a templated manifest to edit and **Create**. */
export function CreateDialog() {
  const { dialog, namespace, setCreateKind, setCreateBuffer, submitCreate, closeCreate } = useAppStore(useShallow((s) => ({
    dialog: s.createDialog, namespace: s.connection.namespace,
    setCreateKind: s.setCreateKind, setCreateBuffer: s.setCreateBuffer, submitCreate: s.submitCreate, closeCreate: s.closeCreate,
  })));

  // Escape closes it from the global key handler (`useGlobalKeys`), like the other dialogs.
  if (!dialog.open) return null;
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="create-dialog-title"
        className="flex h-[min(640px,90vh)] w-[min(720px,90vw)] flex-col rounded-card border border-border bg-surface p-5">
        <div className="mb-3 flex items-center gap-3">
          <h2 id="create-dialog-title" className="text-lg text-text-hi">Create</h2>
          <label className="ml-auto flex items-center gap-2 text-xs text-text-muted">
            Kind
            <select value={dialog.kind} onChange={(e) => setCreateKind(e.target.value as CreatableKind)} disabled={dialog.submitting}
              className="rounded-lg border border-border bg-panel px-2 py-1 text-sm text-text-hi outline-none focus:border-current-b">
              {CREATABLE_KINDS.map((k) => <option key={k} value={k}>{KIND_META[k].label}</option>)}
            </select>
          </label>
          {namespace && <span className="text-xs text-text-muted">in {namespace}</span>}
        </div>
        {dialog.error && (
          <div role="alert" className="mb-3 shrink-0 rounded-lg border border-status-err/40 bg-status-err/10 px-3 py-2 text-xs">
            <div className="mb-1 text-text-hi">{dialog.error.kind === "invalid" ? "The server rejected the manifest:" : "Create failed:"}</div>
            <div className="selectable whitespace-pre-wrap font-mono text-text">{dialog.error.message}</div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-panel">
          <LazyYamlEditor value={dialog.buffer} onChange={setCreateBuffer} label="Manifest" readOnly={dialog.submitting} autoFocus />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button disabled={dialog.submitting} onClick={closeCreate}>Cancel</Button>
          <Button variant="primary" disabled={dialog.submitting} onClick={() => void submitCreate()}>{dialog.submitting ? "Creating…" : "Create"}</Button>
        </div>
      </div>
    </div>
  );
}
