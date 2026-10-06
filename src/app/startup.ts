import { restoredScope } from "../shared/scope";
import { settings } from "../shared/settings";
import { useAppStore } from "./store";

/** Boot: load contexts and reconnect the remembered context/scope. Without contexts the welcome
 *  pane takes over (it loads the kubeconfig sources itself); without a remembered context, or when
 *  it is gone, the navigator's cluster list is the way forward; a failed connect shows its pane. */
export async function startup(): Promise<void> {
  const s = useAppStore.getState;
  useAppStore.setState({ sidebarCollapsed: await settings.getSidebarCollapsed() });
  await s().loadContexts();
  if (s().contexts.length === 0) return;
  const last = await settings.get<string>("lastContext");
  const ctx = last ? s().contexts.find((c) => c.name === last) : undefined;
  if (!ctx) return;
  if (!(await s().connect(ctx.name))) return;
  const remembered = await settings.getLastScope(ctx.name);
  const { namespaces, canListNamespaces } = s().connection;
  // All namespaces needs the permission to list them (it may have been revoked since).
  const scope = restoredScope(remembered, namespaces, canListNamespaces, ctx.namespace);
  if (scope) await s().selectScope(scope);
}
