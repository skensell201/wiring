import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore, type EditorState } from "../../app/store";
import type { AppError } from "../../shared/ipc/types";
import { isMac } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";
import { DiffView } from "../editor/DiffView";
import { LazyYamlEditor } from "../editor/LazyYamlEditor";
import { highlightYaml } from "./yaml";

const TOOLBAR = "flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5";

/** The YAML tab: the object's manifest, read-only until **Edit**; then the editor, and **Save**
 *  leads to a diff review before the write. Banners report a failed write inside the tab. */
export function YamlTab() {
  const { yaml, nodeId, editor } = useAppStore(useShallow((s) => ({ yaml: s.details?.data?.yaml ?? "", nodeId: s.details?.nodeId ?? "", editor: s.details?.editor ?? null })));
  if (!editor || editor.mode === "view") return <ViewMode yaml={yaml} editable={nodeId !== "" && !nodeId.startsWith("PodGroup/")} />;
  if (editor.mode === "review") return <ReviewMode editor={editor} />;
  return <EditMode editor={editor} />;
}

function ViewMode({ yaml, editable }: { yaml: string; editable: boolean }) {
  const startEdit = useAppStore((s) => s.startEdit);
  const [html, setHtml] = useState<string>("");
  useEffect(() => {
    let alive = true;
    void highlightYaml(yaml).then((h) => { if (alive) setHtml(h); });
    return () => { alive = false; };
  }, [yaml]);
  if (yaml === "") return <div className="p-4 text-sm text-text-muted">No YAML for this node.</div>;
  return (
    <div className="flex h-full flex-col">
      <div className={TOOLBAR}>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" title="Copy YAML" onClick={() => void navigator.clipboard.writeText(yaml)}
            className="rounded-md border border-border bg-surface p-1.5 text-text-muted hover:text-text-hi">
            <Copy className="size-4" />
          </button>
          {editable && <Button className="py-1" onClick={startEdit}>Edit</Button>}
        </div>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto">
        <div className="p-4 font-mono text-xs leading-5 [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

function EditMode({ editor }: { editor: EditorState }) {
  const { setBuffer, reviewEdit, cancelEdit } = useAppStore(useShallow((s) => ({ setBuffer: s.setBuffer, reviewEdit: s.reviewEdit, cancelEdit: s.cancelEdit })));
  return (
    <div className="flex h-full flex-col">
      <div className={TOOLBAR}>
        <span className="text-xs text-text-muted">Editing</span>
        <div className="ml-auto flex items-center gap-2">
          <Button className="py-1" disabled={editor.saving} onClick={cancelEdit}>Cancel</Button>
          <Button variant="primary" className="py-1" disabled={editor.saving} onClick={reviewEdit}>
            Save <kbd className="ml-1 text-xs opacity-70">{isMac ? "⌘S" : "Ctrl+S"}</kbd>
          </Button>
        </div>
      </div>
      {editor.error && <ErrorBanner error={editor.error} saving={editor.saving} />}
      <div className="min-h-0 flex-1">
        <LazyYamlEditor value={editor.buffer} onChange={setBuffer} label="YAML editor" autoFocus />
      </div>
    </div>
  );
}

function ReviewMode({ editor }: { editor: EditorState }) {
  const { applyEdit, backToEdit } = useAppStore(useShallow((s) => ({ applyEdit: s.applyEdit, backToEdit: s.backToEdit })));
  return (
    <div className="flex h-full flex-col">
      <div className={TOOLBAR}>
        <span className="text-xs text-text-muted">Review changes</span>
        <div className="ml-auto flex items-center gap-2">
          <Button className="py-1" disabled={editor.saving} onClick={backToEdit}>Back</Button>
          <Button variant="primary" className="py-1" disabled={editor.saving} onClick={() => void applyEdit(false)}>{editor.saving ? "Applying…" : "Apply"}</Button>
        </div>
      </div>
      {editor.error && <ErrorBanner error={editor.error} saving={editor.saving} />}
      <div className="min-h-0 flex-1">
        <DiffView original={editor.original} next={editor.buffer} />
      </div>
    </div>
  );
}

/** The last failed write. A conflict offers to reload or overwrite; a deletion to reload; a
 *  validation failure shows the server's message as it came (it is usually several lines). */
function ErrorBanner({ error, saving }: { error: AppError; saving: boolean }) {
  const { applyEdit, reloadEdit } = useAppStore(useShallow((s) => ({ applyEdit: s.applyEdit, reloadEdit: s.reloadEdit })));
  const warn = error.kind === "conflict";
  const tint = warn ? "border-status-warn/40 bg-status-warn/10" : "border-status-err/40 bg-status-err/10";
  return (
    <div role="alert" data-kind={error.kind} className={`shrink-0 border-b px-3 py-2 text-xs ${tint}`}>
      {error.kind === "conflict" ? (
        <div className="flex items-center gap-3">
          <span className="text-text-hi">This object changed on the server while you were editing.</span>
          <div className="ml-auto flex shrink-0 gap-2">
            <Button className="py-0.5 text-xs" disabled={saving} onClick={() => void reloadEdit()}>Reload</Button>
            <Button className="py-0.5 text-xs" disabled={saving} onClick={() => void applyEdit(true)}>Overwrite</Button>
          </div>
        </div>
      ) : error.kind === "notFound" ? (
        <div className="flex items-center gap-3">
          <span className="text-text-hi">{error.message}</span>
          <Button className="ml-auto shrink-0 py-0.5 text-xs" disabled={saving} onClick={() => void reloadEdit()}>Reload</Button>
        </div>
      ) : error.kind === "invalid" ? (
        <div>
          <div className="mb-1 text-text-hi">The server rejected the manifest:</div>
          <div className="selectable whitespace-pre-wrap font-mono text-text">{error.message}</div>
        </div>
      ) : (
        <span className="text-text-hi">{error.message}</span>
      )}
    </div>
  );
}
