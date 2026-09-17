import { settings } from "../shared/settings";
import { useAppStore } from "./store";

/** Boot: load contexts, reconnect the remembered context/namespace or open the picker. */
export async function startup(): Promise<void> {
  const s = useAppStore.getState;
  await s().loadContexts();
  const last = await settings.get<string>("lastContext");
  const ctx = last ? s().contexts.find((c) => c.name === last) : undefined;
  if (!ctx) {
    s().setPickerOpen(true);
    return;
  }
  if (!(await s().connect(ctx.name))) {
    s().setPickerOpen(true);
    return;
  }
  const remembered = await settings.getLastNamespace(ctx.name);
  const { namespaces } = s().connection;
  const ns = remembered && (namespaces.length === 0 || namespaces.includes(remembered)) ? remembered : ctx.namespace ?? null;
  if (ns) await s().selectNamespace(ns);
}
