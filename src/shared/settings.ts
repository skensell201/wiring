import { load, type Store } from "@tauri-apps/plugin-store";

const FILE = "settings.json";
let store: Promise<Store> | null = null;
const open = () => (store ??= load(FILE, { autoSave: true }));

/** `lastNamespace` is a map keyed by context name. */
type NamespaceMap = Record<string, string>;

const isNamespaceMap = (v: unknown): v is NamespaceMap => typeof v === "object" && v !== null && !Array.isArray(v);

async function readNamespaces(): Promise<NamespaceMap> {
  const v = await settings.get<unknown>("lastNamespace");
  return isNamespaceMap(v) ? v : {}; // a pre-map single string is simply forgotten
}

export const settings = {
  async get<T>(key: "lastContext" | "lastNamespace"): Promise<T | null> {
    try {
      return (await (await open()).get<T>(key)) ?? null;
    } catch {
      return null;
    }
  },
  async set(key: "lastContext" | "lastNamespace", value: unknown): Promise<void> {
    try {
      await (await open()).set(key, value);
    } catch {
      /* settings are a convenience; never block the UI */
    }
  },
  async getLastNamespace(context: string): Promise<string | null> {
    return (await readNamespaces())[context] ?? null;
  },
  async setLastNamespace(context: string, namespace: string): Promise<void> {
    await settings.set("lastNamespace", { ...(await readNamespaces()), [context]: namespace });
  },
  async getSidebarCollapsed(): Promise<boolean> {
    try {
      return (await (await open()).get<boolean>("sidebarCollapsed")) ?? false;
    } catch {
      return false;
    }
  },
  async setSidebarCollapsed(value: boolean): Promise<void> {
    try {
      await (await open()).set("sidebarCollapsed", value);
    } catch {
      /* settings are a convenience; never block the UI */
    }
  },
  /** The details panel height in px, or null when never resized (or the stored value is not a finite number). */
  async getDetailsHeight(): Promise<number | null> {
    try {
      const v = await (await open()).get<unknown>("detailsHeight");
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  },
  async setDetailsHeight(px: number): Promise<void> {
    try {
      await (await open()).set("detailsHeight", px);
    } catch {
      /* settings are a convenience; never block the UI */
    }
  },
};
