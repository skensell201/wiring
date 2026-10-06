import { useAppStore } from "../../app/store";
import { restoredScope } from "../../shared/scope";
import { settings } from "../../shared/settings";

/** Connects to a kubeconfig context, remembers it and reopens its remembered scope — or else its
 *  default namespace (the context's own, or the only one the cluster has). `selectScope`
 *  remembers what it opens. Returns false when the connection failed. */
export async function connectContext(name: string): Promise<boolean> {
  const s = useAppStore.getState();
  const ctx = s.contexts.find((c) => c.name === name);
  if (!(await s.connect(name))) return false;
  await settings.set("lastContext", name);
  const { namespaces, canListNamespaces } = useAppStore.getState().connection;
  const remembered = await settings.getLastScope(name);
  const fallback = ctx?.namespace ?? (namespaces.length === 1 ? namespaces[0] : null);
  const scope = restoredScope(remembered, namespaces, canListNamespaces, null);
  if (scope) await useAppStore.getState().selectScope(scope);
  else if (fallback) await useAppStore.getState().selectNamespace(fallback);
  return true;
}
