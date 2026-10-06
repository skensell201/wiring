import { load, type Store } from "@tauri-apps/plugin-store";
import type { NamespaceScope } from "./ipc/types";

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

type ScopeMap = Record<string, NamespaceScope>;
const isScope = (v: unknown): v is NamespaceScope =>
  v === "all" || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string"));
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const settings = {
  async get<T>(key: "lastContext" | "lastNamespace" | "lastScope"): Promise<T | null> {
    try {
      return (await (await open()).get<T>(key)) ?? null;
    } catch {
      return null;
    }
  },
  async set(key: "lastContext" | "lastNamespace" | "lastScope", value: unknown): Promise<void> {
    try {
      await (await open()).set(key, value);
    } catch {
      /* settings are a convenience; never block the UI */
    }
  },
  /** The context's remembered scope; a pre-scope `lastNamespace` string counts as a one-namespace scope. */
  async getLastScope(context: string): Promise<NamespaceScope | null> {
    const scopes = await settings.get<unknown>("lastScope");
    const remembered = isMap(scopes) ? scopes[context] : undefined;
    if (isScope(remembered)) return remembered;
    const legacy = (await readNamespaces())[context];
    return typeof legacy === "string" && legacy !== "" ? [legacy] : null;
  },
  async setLastScope(context: string, scope: NamespaceScope): Promise<void> {
    const scopes = await settings.get<unknown>("lastScope");
    const map: ScopeMap = isMap(scopes) ? (Object.fromEntries(Object.entries(scopes).filter(([, v]) => isScope(v))) as ScopeMap) : {};
    await settings.set("lastScope", { ...map, [context]: scope });
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
