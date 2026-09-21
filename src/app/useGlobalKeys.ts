import { useEffect } from "react";
import { isMac } from "../shared/platform";
import { useAppStore } from "./store";

/** App-wide keyboard shortcuts that do not belong to a single widget. */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const s = useAppStore.getState();
      const modal = s.pickerOpen || s.discardDialog.open || s.deleteDialog.open || s.createDialog.open;
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
        // Save = review the diff, unless something sits on top of the editor. Outside edit mode
        // the browser's own Save is as useless as ever; leave it.
        if (!modal && s.details?.editor.mode === "edit") {
          e.preventDefault();
          s.reviewEdit();
        }
        return;
      }
      if (e.key !== "Escape") return;
      // An open context picker owns Escape (it closes itself when it can, marking the event handled).
      if (s.pickerOpen) return;
      // Innermost layer first: dialogs, then a maximised details panel, then the editor, then the selection.
      if (s.discardDialog.open) { s.cancelDiscard(); return; }
      if (s.deleteDialog.open) { s.cancelDelete(); return; }
      if (s.createDialog.open) { s.closeCreate(); return; }
      if (s.detailsMaximized) { s.toggleDetailsMaximized(); return; }
      const editor = s.details?.editor;
      if (editor?.saving) return; // a write in flight: nothing to leave until it lands
      if (editor?.mode === "review") { s.backToEdit(); return; }
      if (editor?.mode === "edit") { s.cancelEdit(); return; }
      if (s.selectedId !== null) void s.select(null);
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
