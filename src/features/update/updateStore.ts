import { create } from "zustand";
import { useAppStore } from "../../app/store";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type UpdateInfo, type UpdateProgress } from "../../shared/ipc/types";

interface UpdateData {
  available: UpdateInfo | null;
  current: string | null;
  /** "Later" was chosen: no pill until the next launch. */
  dismissed: boolean;
  dialogOpen: boolean;
  installing: boolean;
  progress: UpdateProgress | null;
  error: string | null;
}

export interface UpdateStore extends UpdateData {
  /** Ask the feed. `manual` (the menu item) opens the dialog or reports "up to date" / errors as toasts. */
  check: (manual: boolean) => Promise<void>;
  openDialog: () => void;
  later: () => void;
  install: () => Promise<void>;
  setProgress: (p: UpdateProgress) => void;
}

export const initialUpdateState = (): UpdateData => ({
  available: null, current: null, dismissed: false, dialogOpen: false, installing: false, progress: null, error: null,
});

export const useUpdateStore = create<UpdateStore>()((set, get) => ({
  ...initialUpdateState(),
  check: async (manual) => {
    try {
      const r = await commands.checkUpdate();
      set({ current: r.current, available: r.update });
      if (!manual) return;
      if (r.update) set({ dialogOpen: true, dismissed: false, error: null });
      else useAppStore.getState().toast({ kind: "info", message: `Wiring ${r.current} is up to date` });
    } catch (e) {
      if (manual) useAppStore.getState().toast(toAppError(e));
    }
  },
  openDialog: () => set({ dialogOpen: true, error: null }),
  later: () => { if (!get().installing) set({ dialogOpen: false, dismissed: true }); },
  install: async () => {
    if (get().installing) return;
    set({ installing: true, error: null, progress: null });
    try {
      await commands.installUpdate(); // relaunches on success, so this only returns on failure
    } catch (e) {
      set({ installing: false, error: toAppError(e).message });
    }
  },
  setProgress: (progress) => set({ progress }),
}));
