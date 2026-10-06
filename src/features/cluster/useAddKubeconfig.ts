import { open } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { useAppStore } from "../../app/store";

/** Opens the file dialog and registers the chosen kubeconfig (shared by the welcome pane and the Navigator). */
export function useAddKubeconfig(): () => Promise<void> {
  const addKubeconfig = useAppStore((s) => s.addKubeconfig);
  return useCallback(async () => {
    const path = await open({ multiple: false, directory: false, title: "Add kubeconfig file" });
    if (typeof path === "string") await addKubeconfig(path);
  }, [addKubeconfig]);
}
