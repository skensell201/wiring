import { lazy, Suspense } from "react";

const Canvas = lazy(() => import("./Canvas").then((m) => ({ default: m.Canvas })));

/** `Canvas` in its own chunk: React Flow stays out of the main bundle until the graph is shown.
 *  The canvas is not mounted while a connection pane stands in for it, so the chunk loads while
 *  the app is still connecting rather than delaying the first paint. */
export function LazyCanvas() {
  return (
    <Suspense fallback={<div className="grid h-full place-items-center text-sm text-text-muted">Loading graph…</div>}>
      <Canvas />
    </Suspense>
  );
}
