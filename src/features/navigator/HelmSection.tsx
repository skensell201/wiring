import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { ACTIVE, IDLE, ROW, SectionGroup } from "./treeParts";

/** Helm: one entry for the releases list, with the release count of the scope. */
export function HelmSection() {
  const { ready, active, releases, showHelm, refreshHelm } = useAppStore(
    useShallow((s) => ({
      ready: s.connection.state === "connected" && s.connection.scope !== null && s.graphReady,
      active: s.view.name === "helm", releases: s.helmReleases, showHelm: s.showHelm, refreshHelm: s.refreshHelm,
    })),
  );
  const [open, setOpen] = useState(true);
  // The releases come from the watched Secrets, which are in once the first snapshot landed.
  useEffect(() => {
    if (ready && releases === null) void refreshHelm();
  }, [ready, releases, refreshHelm]);
  if (!ready) return null;
  return (
    <SectionGroup section={{ id: "helm", label: "Helm" }} open={open} onToggle={() => setOpen((o) => !o)}>
      <button type="button" aria-current={active ? "page" : undefined} onClick={() => void showHelm()}
        className={`${ROW} pl-8 ${active ? ACTIVE : IDLE}`}>
        <span className="flex-1 truncate">Releases</span>
        {" "/* a flex row drops it; it keeps the accessible name "Releases 3" */}
        {releases && <span className="text-xs tabular-nums text-text-muted">{releases.length}</span>}
      </button>
    </SectionGroup>
  );
}
