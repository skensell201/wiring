import { lazy, Suspense } from "react";
import type { YamlEditorProps } from "./YamlEditor";

const Editor = lazy(() => import("./YamlEditor"));

/** `YamlEditor` in its own chunk: CodeMirror stays out of the main bundle until an edit starts. */
export function LazyYamlEditor(props: YamlEditorProps) {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-text-muted">Loading editor…</div>}>
      <Editor {...props} />
    </Suspense>
  );
}
