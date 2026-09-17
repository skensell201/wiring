import { invoke } from "./tauri";
import type { ConnectInfo, ContextInfo, Kind, NodeId, ObjectDetails } from "./types";
import { toAppError } from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const commands = {
  listContexts: () => call<ContextInfo[]>("list_contexts"),
  addKubeconfig: (path: string) => call<ContextInfo[]>("add_kubeconfig", { path }),
  connect: (context: string) => call<ConnectInfo>("connect", { context }),
  disconnect: () => call<null>("disconnect"),
  selectNamespace: (namespace: string, expandedGroups: NodeId[]) => call<null>("select_namespace", { namespace, expandedGroups }),
  setExpandedGroups: (expandedGroups: NodeId[]) => call<null>("set_expanded_groups", { expandedGroups }),
  getObject: (nodeId: NodeId) => call<ObjectDetails>("get_object", { nodeId }),
  watchEvents: (nodeId: NodeId | null) => call<null>("watch_events", { nodeId }),
  deniedKinds: () => call<Kind[]>("denied_kinds"),
};
