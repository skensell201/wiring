import { useShallow } from "zustand/react/shallow";
import { useUpdateStore } from "./updateStore";

/** "Update 0.3.0" in the header while a newer release is offered and not put off with Later. */
export function UpdatePill() {
  const { available, dismissed, openDialog } = useUpdateStore(useShallow((s) => ({ available: s.available, dismissed: s.dismissed, openDialog: s.openDialog })));
  if (!available || dismissed) return null;
  return (
    <button type="button" onClick={openDialog}
      className="no-drag rounded-xl bg-accent/15 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/25">
      Update {available.version}
    </button>
  );
}
