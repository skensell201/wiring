import { useEffect } from "react";
import { startup } from "./app/startup";
import { useAppStore } from "./app/store";
import { useGlobalKeys } from "./app/useGlobalKeys";
import { wireEvents } from "./app/wireEvents";
import { ContextPicker } from "./features/cluster/ContextPicker";
import { Header } from "./features/cluster/Header";
import { DetailsPanel } from "./features/details/DetailsPanel";
import { CreateDialog } from "./features/editor/CreateDialog";
import { Canvas } from "./features/graph/Canvas";
import { ViewHeader } from "./features/graph/ViewHeader";
import { Navigator } from "./features/navigator/Navigator";
import { TableView } from "./features/table/TableView";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary";
import { Toasts } from "./shared/ui/Toasts";

export function App() {
  useGlobalKeys();
  const viewName = useAppStore((s) => s.view.name);
  const maximized = useAppStore((s) => s.detailsMaximized);
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void (async () => {
      const s = await wireEvents();
      if (!active) { s(); return; }
      stop = s;
      await startup();
    })();
    return () => { active = false; stop?.(); };
  }, []);

  return (
    <div className="relative flex h-full">
      <ErrorBoundary name="navigator"><Navigator /></ErrorBoundary>
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        {/* A maximised details panel takes the whole column; the view under it is unmounted, not hidden,
            so a busy graph stops rendering while logs fill the screen. */}
        {!maximized && (
          <>
            <ViewHeader />
            <main className="min-h-0 flex-1">
              <ErrorBoundary name="main view">{viewName === "graph" ? <Canvas /> : <TableView />}</ErrorBoundary>
            </main>
          </>
        )}
        <ErrorBoundary name="details panel"><DetailsPanel /></ErrorBoundary>
      </div>
      {/* The dialogs sit outside the columns; a failure in one (the lazily loaded editor, say) must not blank the app. */}
      <ErrorBoundary name="cluster picker"><ContextPicker /></ErrorBoundary>
      <ErrorBoundary name="create dialog"><CreateDialog /></ErrorBoundary>
      <Toasts />
    </div>
  );
}
