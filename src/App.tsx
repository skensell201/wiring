import { useEffect } from "react";
import { startup } from "./app/startup";
import { wireEvents } from "./app/wireEvents";
import { ContextPicker } from "./features/cluster/ContextPicker";
import { Header } from "./features/cluster/Header";
import { DetailsPanel } from "./features/details/DetailsPanel";
import { Canvas } from "./features/graph/Canvas";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary";
import { Toasts } from "./shared/ui/Toasts";

export function App() {
  useEffect(() => {
    let stop: (() => void) | undefined;
    void wireEvents().then((s) => { stop = s; }).then(startup);
    return () => stop?.();
  }, []);

  return (
    <div className="relative flex h-full flex-col">
      <Header />
      <main className="min-h-0 flex-1">
        <ErrorBoundary name="graph view"><Canvas /></ErrorBoundary>
      </main>
      <ErrorBoundary name="details panel"><DetailsPanel /></ErrorBoundary>
      <ContextPicker />
      <Toasts />
    </div>
  );
}
