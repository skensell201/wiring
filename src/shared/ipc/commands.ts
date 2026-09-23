import { Channel, invoke } from "./tauri";
import type { ConnectInfo, ContextInfo, Kind, LogMessage, LogRequest, NodeId, ObjectDetails, Table } from "./types";
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
  listRows: (kind: Kind) => call<Table>("list_rows", { kind }),
  updateObject: (nodeId: NodeId, yaml: string, force: boolean) => call<ObjectDetails>("update_object", { nodeId, yaml, force }),
  createObject: (namespace: string, yaml: string) => call<NodeId>("create_object", { namespace, yaml }),
  deleteObject: (nodeId: NodeId) => call<null>("delete_object", { nodeId }),
  /** Starts a log session; `onMessage` receives every LogMessage until stopLogs. Resolves to the session id. */
  startLogs: (req: LogRequest, onMessage: (m: LogMessage) => void) => {
    const channel = new Channel<LogMessage>();
    channel.onmessage = onMessage;
    return call<number>("start_logs", { ...req, onMessage: channel });
  },
  stopLogs: (sessionId: number) => call<null>("stop_logs", { sessionId }),
  saveText: (path: string, text: string) => call<null>("save_text", { path, text }),
};
