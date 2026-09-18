import { useAppStore } from "../../app/store";
import { settings } from "../../shared/settings";

/** Connects to a kubeconfig context, remembers it and opens its default namespace (the context's
 *  own, or the only one the cluster has). Returns false when the connection failed. */
export async function connectContext(name: string): Promise<boolean> {
  const s = useAppStore.getState();
  const ctx = s.contexts.find((c) => c.name === name);
  if (!(await s.connect(name))) return false;
  await settings.set("lastContext", name);
  const namespaces = useAppStore.getState().connection.namespaces;
  const ns = ctx?.namespace ?? (namespaces.length === 1 ? namespaces[0] : null);
  if (ns) {
    await useAppStore.getState().selectNamespace(ns);
    await settings.setLastNamespace(name, ns);
  }
  return true;
}
