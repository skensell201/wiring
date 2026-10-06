import { open } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { useAppStore } from "../../app/store";
import { toAppError } from "../../shared/ipc/types";

/** Opens the file dialog and registers the chosen kubeconfig (shared by the welcome pane and the Navigator). */
export function useAddKubeconfig(): () => Promise<void> {
  const addKubeconfig = useAppStore((s) => s.addKubeconfig);
  const toast = useAppStore((s) => s.toast);
  return useCallback(async () => {
    try {
      const path = await open({ multiple: false, directory: false, title: "Add kubeconfig file" });
      if (typeof path === "string") await addKubeconfig(path);
    } catch (e) {
      // Callers fire-and-forget this, so a failing dialog must not escape as an unhandled rejection.
      toast(toAppError(e));
    }
  }, [addKubeconfig, toast]);
}
