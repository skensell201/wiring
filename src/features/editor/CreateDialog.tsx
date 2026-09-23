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
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80">
      <div role="dialog" aria-modal="true" aria-labelledby="create-dialog-title"
        className="flex h-[min(640px,90vh)] w-[min(720px,90vw)] flex-col rounded-card border border-border bg-surface p-8">
        <div className="mb-5 flex items-center gap-3">
          <h2 id="create-dialog-title" className="text-2xl font-semibold leading-[1.33] text-text-hi">Create</h2>
          <label className="ml-auto flex items-center gap-2 text-xs text-text-muted">
            Kind
            <select value={dialog.kind} onChange={(e) => setCreateKind(e.target.value as CreatableKind)} disabled={dialog.submitting}
              className="h-9 rounded-md border border-border bg-space px-3 text-sm text-text-hi outline-none focus:border-supernova">
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
        <div className="min-h-0 flex-1 overflow-hidden rounded-card border border-border bg-void">
          <LazyYamlEditor value={dialog.buffer} onChange={setCreateBuffer} label="Manifest" readOnly={dialog.submitting} autoFocus />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button disabled={dialog.submitting} onClick={closeCreate}>Cancel</Button>
          <Button variant="primary" disabled={dialog.submitting} onClick={() => void submitCreate()}>{dialog.submitting ? "Creating…" : "Create"}</Button>
        </div>
      </div>
    </div>
  );
}
