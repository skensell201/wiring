import { settings } from "../shared/settings";
import { useAppStore } from "./store";

/** Boot: load contexts and reconnect the remembered context/namespace. Without a remembered
 *  context (or when it is gone or fails) the Navigator's cluster list is the way forward; the
 *  modal picker opens only when there are no contexts at all. */
export async function startup(): Promise<void> {
  const s = useAppStore.getState;
  useAppStore.setState({ sidebarCollapsed: await settings.getSidebarCollapsed() });
  await s().loadContexts();
  if (s().contexts.length === 0) {
    s().setPickerOpen(true);
    return;
  }
  const last = await settings.get<string>("lastContext");
  const ctx = last ? s().contexts.find((c) => c.name === last) : undefined;
  if (!ctx) return;
  // A failed connect lands in disconnectedState, which decides about the picker itself.
  if (!(await s().connect(ctx.name))) return;
  const remembered = await settings.getLastNamespace(ctx.name);
  const { namespaces } = s().connection;
  const ns = remembered && (namespaces.length === 0 || namespaces.includes(remembered)) ? remembered : ctx.namespace ?? null;
  if (ns) await s().selectNamespace(ns);
}
