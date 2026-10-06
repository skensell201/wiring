import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { Button } from "../../shared/ui/Button";
import { KIND_META } from "../graph/kindMeta";
import { LazyYamlEditor } from "./LazyYamlEditor";
import { CREATABLE_KINDS, type CreatableKind } from "./templates";

/** The **+ Create** modal: a kind picker, a templated manifest to edit and **Create**. */
export function CreateDialog() {
  const { dialog, namespaces, setCreateNamespace, setCreateKind, setCreateBuffer, submitCreate, closeCreate } = useAppStore(useShallow((s) => ({
    dialog: s.createDialog, namespaces: s.connection.namespaces, setCreateNamespace: s.setCreateNamespace,
    setCreateKind: s.setCreateKind, setCreateBuffer: s.setCreateBuffer, submitCreate: s.submitCreate, closeCreate: s.closeCreate,
  })));

  // Escape closes it from the global key handler (`useGlobalKeys`), like the other dialogs.
  if (!dialog.open) return null;
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80">
      <div role="dialog" aria-modal="true" aria-labelledby="create-dialog-title"
        className="flex h-[min(640px,90vh)] w-[min(720px,90vw)] flex-col rounded-card border border-border bg-elevated p-8">
        <div className="mb-5 flex items-center gap-3">
          <h2 id="create-dialog-title" className="text-2xl font-semibold leading-[1.33] text-text-hi">Create</h2>
          <label className="ml-auto flex items-center gap-2 text-xs text-text-muted">
            Kind
            <select value={dialog.kind} onChange={(e) => setCreateKind(e.target.value as CreatableKind)} disabled={dialog.submitting}
              className="h-9 rounded-xl border border-border-strong bg-surface px-3 text-sm text-text-hi outline-none focus:border-accent">
              {CREATABLE_KINDS.map((k) => <option key={k} value={k}>{KIND_META[k].label}</option>)}
            </select>
          </label>
          {dialog.kind !== "PersistentVolume" && (
            <label className="flex items-center gap-2 text-xs text-text-muted">
              Namespace
              {namespaces.length > 0 ? (
                <select aria-label="Namespace" value={dialog.namespace} onChange={(e) => setCreateNamespace(e.target.value)} disabled={dialog.submitting}
                  className="h-9 rounded-xl border border-border-strong bg-surface px-3 text-sm text-text-hi outline-none focus:border-accent">
                  {(namespaces.includes(dialog.namespace) ? namespaces : [dialog.namespace, ...namespaces]).map((ns) => <option key={ns} value={ns}>{ns}</option>)}
                </select>
              ) : (
                <input aria-label="Namespace" value={dialog.namespace} onChange={(e) => setCreateNamespace(e.target.value)} disabled={dialog.submitting}
                  className="h-9 w-40 rounded-xl border border-border-strong bg-surface px-3 text-sm text-text-hi outline-none focus:border-accent" />
              )}
            </label>
          )}
        </div>
        {dialog.error && (
          <div role="alert" className="mb-3 shrink-0 rounded-lg border border-status-err/40 bg-status-err/10 px-3 py-2 text-xs">
            <div className="mb-1 text-text-hi">{dialog.error.kind === "invalid" ? "The server rejected the manifest:" : "Create failed:"}</div>
            <div className="selectable whitespace-pre-wrap font-mono text-text">{dialog.error.message}</div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden rounded-card border border-border bg-surface">
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
