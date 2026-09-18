import { useEffect } from "react";
import { isMac } from "../shared/platform";
import { useAppStore } from "./store";

/** App-wide keyboard shortcuts that do not belong to a single widget. */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const s = useAppStore.getState();
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "s") {
        // Save = review the diff. Outside edit mode the browser's own Save is as useless as ever; leave it.
        if (s.details?.editor.mode === "edit") {
          e.preventDefault();
          s.reviewEdit();
        }
        return;
      }
      if (e.key !== "Escape") return;
      // An open context picker owns Escape (it closes itself when it can, marking the event handled).
      if (s.pickerOpen) return;
      // Innermost layer first: dialogs, then the editor, then the selection.
      if (s.discardDialog.open) { s.cancelDiscard(); return; }
      if (s.deleteDialog.open) { s.cancelDelete(); return; }
      if (s.createDialog.open) { s.closeCreate(); return; }
      const mode = s.details?.editor.mode;
      if (mode === "review") { s.backToEdit(); return; }
      if (mode === "edit") { s.cancelEdit(); return; }
      if (s.selectedId !== null) void s.select(null);
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
