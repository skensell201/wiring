import { restoredScope } from "../shared/scope";
import { settings } from "../shared/settings";
import { useAppStore } from "./store";

/** Boot: load contexts and reconnect the remembered context/scope. Without contexts the welcome
 *  pane takes over (it loads the kubeconfig sources itself); without a remembered context, or when
 *  it is gone, the navigator's cluster list is the way forward; a failed connect shows its pane.
 *  A remembered context shows as connecting from before the contexts load, so the choose pane never
 *  flashes between the list arriving and the dial. */
export async function startup(): Promise<void> {
  const s = useAppStore.getState;
  const [sidebarCollapsed, last] = await Promise.all([settings.getSidebarCollapsed(), settings.get<string>("lastContext")]);
  useAppStore.setState({ sidebarCollapsed });
  if (last) useAppStore.setState((st) => ({ connection: { ...st.connection, connecting: last } }));
  await s().loadContexts();
  if (!last) return;
  // Cancelled (or another connect started) while the contexts loaded: that choice stands.
  if (s().connection.connecting !== last) return;
  const ctx = s().contexts.find((c) => c.name === last);
  if (!ctx) {
    useAppStore.setState((st) => ({ connection: { ...st.connection, connecting: null } }));
    return;
  }
  if (!(await s().connect(ctx.name))) return;
  const remembered = await settings.getLastScope(ctx.name);
  const { namespaces, canListNamespaces } = s().connection;
  // All namespaces needs the permission to list them (it may have been revoked since).
  const scope = restoredScope(remembered, namespaces, canListNamespaces, ctx.namespace);
  if (scope) await s().selectScope(scope);
}
