import { Channel, invoke } from "./tauri";
import type { ConnectInfo, ContextInfo, ExecMessage, ExecPod, ExecRequest, Forward, Kind, LogMessage, LogRequest, NamespaceScope, NodeId, ObjectDetails, PortOption, Revision, Table, UpdateCheck } from "./types";
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
  selectNamespaces: (scope: NamespaceScope, expandedGroups: NodeId[]) =>
    call<null>("select_namespaces", { namespaces: scope === "all" ? null : scope, expandedGroups }),
  partialKinds: () => call<Kind[]>("partial_kinds"),
  setExpandedGroups: (expandedGroups: NodeId[]) => call<null>("set_expanded_groups", { expandedGroups }),
  getObject: (nodeId: NodeId) => call<ObjectDetails>("get_object", { nodeId }),
  watchEvents: (nodeId: NodeId | null) => call<null>("watch_events", { nodeId }),
  deniedKinds: () => call<Kind[]>("denied_kinds"),
  listRows: (kind: Kind) => call<Table>("list_rows", { kind }),
  updateObject: (nodeId: NodeId, yaml: string, force: boolean) => call<ObjectDetails>("update_object", { nodeId, yaml, force }),
  createObject: (namespace: string, yaml: string) => call<NodeId>("create_object", { namespace, yaml }),
  deleteObject: (nodeId: NodeId) => call<null>("delete_object", { nodeId }),
  scaleObject: (nodeId: NodeId, replicas: number) => call<ObjectDetails>("scale_object", { nodeId, replicas }),
  restartObject: (nodeId: NodeId) => call<ObjectDetails>("restart_object", { nodeId }),
  rolloutHistory: (nodeId: NodeId) => call<Revision[]>("rollout_history", { nodeId }),
  rollbackObject: (nodeId: NodeId, revision: number) => call<ObjectDetails>("rollback_object", { nodeId, revision }),
  /** Starts a log session; `onMessage` receives every LogMessage until stopLogs. Resolves to the session id. */
  startLogs: (req: LogRequest, onMessage: (m: LogMessage) => void) => {
    const channel = new Channel<LogMessage>();
    channel.onmessage = onMessage;
    return call<number>("start_logs", { ...req, onMessage: channel });
  },
  stopLogs: (sessionId: number) => call<null>("stop_logs", { sessionId }),
  execPods: (nodeId: NodeId) => call<ExecPod[]>("exec_pods", { nodeId }),
  /** Returns at once; output, the end and connect errors arrive on `onMessage`. */
  startExec: (req: ExecRequest, onMessage: (m: ExecMessage) => void) => {
    const channel = new Channel<ExecMessage>();
    channel.onmessage = onMessage;
    return call<number>("start_exec", { ...req, onMessage: channel });
  },
  /** `data` is base64. */
  execInput: (sessionId: number, data: string) => call<null>("exec_input", { sessionId, data }),
  execResize: (sessionId: number, cols: number, rows: number) => call<null>("exec_resize", { sessionId, cols, rows }),
  stopExec: (sessionId: number) => call<null>("stop_exec", { sessionId }),
  forwardPorts: (nodeId: NodeId) => call<PortOption[]>("forward_ports", { nodeId }),
  checkUpdate: () => call<UpdateCheck>("check_update"),
  /** Resolves only on failure: success relaunches the app. */
  installUpdate: () => call<null>("install_update"),
  suggestLocalPort: (port: number) => call<number>("suggest_local_port", { port }),
  /** Returns at once with status "active"; the real status and pod arrive via `forwards_changed`. */
  startForward: (nodeId: NodeId, remotePort: number, localPort: number) => call<Forward>("start_forward", { nodeId, remotePort, localPort }),
  /** Resolves once the local port is free again. */
  stopForward: (id: number) => call<null>("stop_forward", { id }),
  /** Opens http://127.0.0.1:<localPort> from Rust. */
  openForward: (id: number) => call<null>("open_forward", { id }),
  saveText: (path: string, text: string) => call<null>("save_text", { path, text }),
};
