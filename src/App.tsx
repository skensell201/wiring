import { useEffect } from "react";
import { startup } from "./app/startup";
import { useGlobalKeys } from "./app/useGlobalKeys";
import { wireEvents } from "./app/wireEvents";
import { ContextPicker } from "./features/cluster/ContextPicker";
import { Header } from "./features/cluster/Header";
import { DetailsPanel } from "./features/details/DetailsPanel";
import { Canvas } from "./features/graph/Canvas";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary";
import { Toasts } from "./shared/ui/Toasts";

export function App() {
  useGlobalKeys();
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
