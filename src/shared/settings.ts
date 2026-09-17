import { load, type Store } from "@tauri-apps/plugin-store";

const FILE = "settings.json";
let store: Promise<Store> | null = null;
const open = () => (store ??= load(FILE, { autoSave: true }));

export const settings = {
  async get<T>(key: "lastContext" | "lastNamespace"): Promise<T | null> {
    try {
      return (await (await open()).get<T>(key)) ?? null;
    } catch {
      return null;
    }
  },
  async set(key: "lastContext" | "lastNamespace", value: string | null): Promise<void> {
    try {
      await (await open()).set(key, value);
    } catch {
      /* settings are a convenience; never block the UI */
    }
  },
};
