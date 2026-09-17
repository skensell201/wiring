import { useEffect } from "react";
import { useAppStore } from "./store";

/** App-wide keyboard shortcuts that do not belong to a single widget. */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const s = useAppStore.getState();
      // An open context picker owns Escape (it closes itself when it can, marking the event handled).
      if (s.pickerOpen) return;
      if (s.selectedId !== null) void s.select(null);
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
