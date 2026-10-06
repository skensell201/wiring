import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
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
import { HelmView } from "./features/helm/HelmView";
import { Navigator } from "./features/navigator/Navigator";
import { ConnectionPane } from "./features/onboarding/ConnectionPane";
import { connectionPane } from "./features/onboarding/panes";
import { CustomTableView } from "./features/table/CustomTableView";
import { TableView } from "./features/table/TableView";
import { refKey } from "./shared/customId";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary";
import { ActionDialogs } from "./features/actions/ActionDialogs";
import { ActionsMenu } from "./features/actions/ActionsMenu";
import { UpdateDialog } from "./features/update/UpdateDialog";
import { useUpdateChecker } from "./features/update/useUpdateChecker";
import { Toasts } from "./shared/ui/Toasts";

export function App() {
  useGlobalKeys();
  useUpdateChecker();
  const viewName = useAppStore((s) => s.view.name);
  const customKey = useAppStore((s) => (s.view.name === "custom" ? refKey(s.view.resource) : null));
  const maximized = useAppStore((s) => s.detailsMaximized);
  const pane = useAppStore(useShallow((s) => connectionPane(s.connection, s.contexts.length)));
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
        {!maximized && pane && (
          <main className="min-h-0 flex-1">
            <ErrorBoundary name="connection pane"><ConnectionPane pane={pane} /></ErrorBoundary>
          </main>
        )}
        {!maximized && !pane && (
          <>
            <ViewHeader />
            <main className="min-h-0 flex-1">
              <ErrorBoundary name="main view">{viewName === "graph" ? <Canvas /> : viewName === "custom" ? <CustomTableView key={customKey} /> : viewName === "helm" ? <HelmView /> : <TableView />}</ErrorBoundary>
            </main>
          </>
        )}
        <ErrorBoundary name="details panel"><DetailsPanel /></ErrorBoundary>
      </div>
      {/* The dialogs sit outside the columns; a failure in one (the lazily loaded editor, say) must not blank the app. */}
      <ErrorBoundary name="cluster picker"><ContextPicker /></ErrorBoundary>
      <ErrorBoundary name="create dialog"><CreateDialog /></ErrorBoundary>
      <ErrorBoundary name="action dialogs"><ActionDialogs /></ErrorBoundary>
      <ErrorBoundary name="actions menu"><ActionsMenu /></ErrorBoundary>
      <ErrorBoundary name="update dialog"><UpdateDialog /></ErrorBoundary>
      <Toasts />
    </div>
  );
}
