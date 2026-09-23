// Mirrors of the Rust payload types. Keep in sync with src/shared/ipc/fixtures/*.json
// and docs/ipc-contract.md. Runtime guards are deliberately shallow: they check
// shapes and enum values, not every optional field.

export const KINDS = [
  "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod", "Service", "Ingress",
  "ConfigMap", "Secret", "PersistentVolumeClaim", "PersistentVolume", "ServiceAccount", "HorizontalPodAutoscaler",
  "PodGroup",
] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = ["ok", "warn", "err", "unknown"] as const;
export type Status = (typeof STATUSES)[number];

export const RELATIONS = ["owns", "selects", "routes", "mounts", "envFrom", "claims", "binds", "usesSA", "scales"] as const;
export type Relation = (typeof RELATIONS)[number];

export const ERROR_KINDS = ["auth", "network", "forbidden", "notFound", "conflict", "invalid", "internal"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const CONNECTION_STATES = ["connected", "degraded", "disconnected"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type NodeId = string;

export interface GroupInfo { count: number; ok: number; warn: number; err: number }

export interface GraphNode {
  id: NodeId;
  kind: Kind;
  namespace: string | null;
  name: string;
  status: Status;
  badges: string[];
  group: GroupInfo | null;
}

export interface GraphEdge { id: string; source: NodeId; target: NodeId; relation: Relation }

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface GraphDelta {
  addedNodes: GraphNode[];
  updatedNodes: GraphNode[];
  removedNodes: NodeId[];
  addedEdges: GraphEdge[];
  removedEdges: string[];
}

export interface ContextInfo { name: string; cluster: string; user: string; namespace: string | null; sourceFile: string }
export interface ConnectInfo { context: string; serverVersion: string; namespaces: string[] }
export interface ObjectDetails { yaml: string; summary: [string, string][]; related: NodeId[] }
export interface K8sEvent {
  name: string; type: string; reason: string; message: string; count: number;
  firstTimestamp: string | null; lastTimestamp: string | null;
}
export interface ObjectEvents { nodeId: NodeId; events: K8sEvent[] }
export interface AppError { kind: ErrorKind; message: string }

export interface TableColumn { key: string; label: string; numeric: boolean }
export interface TableCell { text: string; status: Status | null }
export interface TableRow { nodeId: NodeId; status: Status; cells: TableCell[] }
export interface Table { kind: Kind; columns: TableColumn[]; rows: TableRow[] }

export interface LogLine { pod: string; container: string; text: string }
export type LogMessage =
  | { type: "lines"; sessionId: number; lines: LogLine[] }
  | { type: "started"; sessionId: number; pod: string; container: string }
  | { type: "ended"; sessionId: number; pod: string; container: string }
  | { type: "error"; sessionId: number; pod: string; container: string; message: string }
  | { type: "truncated"; sessionId: number; limit: number };

export interface LogRequest { nodeId: NodeId; container: string | null; previous: boolean; timestamps: boolean }

// ---- guards ---------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => isStr(v) && (list as readonly string[]).includes(v);
const arrayOf = <T>(v: unknown, g: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(g);

export function isGraphNode(v: unknown): v is GraphNode {
  return isObj(v) && isStr(v.id) && oneOf(KINDS, v.kind) && isStrOrNull(v.namespace) && isStr(v.name)
    && oneOf(STATUSES, v.status) && arrayOf(v.badges, isStr) && (v.group === null || (isObj(v.group) && typeof v.group.count === "number"));
}
export function isGraphEdge(v: unknown): v is GraphEdge {
  return isObj(v) && isStr(v.id) && isStr(v.source) && isStr(v.target) && oneOf(RELATIONS, v.relation);
}
export function isGraph(v: unknown): v is Graph {
  return isObj(v) && arrayOf(v.nodes, isGraphNode) && arrayOf(v.edges, isGraphEdge);
}
export function isGraphDelta(v: unknown): v is GraphDelta {
  return isObj(v) && arrayOf(v.addedNodes, isGraphNode) && arrayOf(v.updatedNodes, isGraphNode)
    && arrayOf(v.removedNodes, isStr) && arrayOf(v.addedEdges, isGraphEdge) && arrayOf(v.removedEdges, isStr);
}
export function isContextInfo(v: unknown): v is ContextInfo {
  return isObj(v) && isStr(v.name) && isStr(v.cluster) && isStr(v.user) && isStrOrNull(v.namespace) && isStr(v.sourceFile);
}
export function isConnectInfo(v: unknown): v is ConnectInfo {
  return isObj(v) && isStr(v.context) && isStr(v.serverVersion) && arrayOf(v.namespaces, isStr);
}
export function isObjectDetails(v: unknown): v is ObjectDetails {
  return isObj(v) && isStr(v.yaml) && Array.isArray(v.summary)
    && v.summary.every((r) => Array.isArray(r) && r.length === 2 && isStr(r[0]) && isStr(r[1])) && arrayOf(v.related, isStr);
}
export function isK8sEvent(v: unknown): v is K8sEvent {
  return isObj(v) && isStr(v.name) && isStr(v.type) && isStr(v.reason) && isStr(v.message) && typeof v.count === "number"
    && isStrOrNull(v.firstTimestamp) && isStrOrNull(v.lastTimestamp);
}
export function isObjectEvents(v: unknown): v is ObjectEvents {
  return isObj(v) && isStr(v.nodeId) && arrayOf(v.events, isK8sEvent);
}
export function isTableColumn(v: unknown): v is TableColumn {
  return isObj(v) && isStr(v.key) && isStr(v.label) && typeof v.numeric === "boolean";
}
export function isTableCell(v: unknown): v is TableCell {
  return isObj(v) && isStr(v.text) && (v.status === null || oneOf(STATUSES, v.status));
}
function isTableRowWithColumns(columns: number) {
  return (v: unknown): v is TableRow =>
    isObj(v) && isStr(v.nodeId) && oneOf(STATUSES, v.status) && arrayOf(v.cells, isTableCell) && v.cells.length === columns;
}
export function isTable(v: unknown): v is Table {
  return isObj(v) && oneOf(KINDS, v.kind) && arrayOf(v.columns, isTableColumn)
    && arrayOf(v.rows, isTableRowWithColumns(v.columns.length));
}
export function isConnectionState(v: unknown): v is ConnectionState { return oneOf(CONNECTION_STATES, v); }
const isLogLine = (v: unknown): v is LogLine => isObj(v) && isStr(v.pod) && isStr(v.container) && isStr(v.text);
export function isLogMessage(v: unknown): v is LogMessage {
  if (!isObj(v) || typeof v.sessionId !== "number") return false;
  switch (v.type) {
    case "lines": return arrayOf(v.lines, isLogLine);
    case "started": case "ended": return isStr(v.pod) && isStr(v.container);
    case "error": return isStr(v.pod) && isStr(v.container) && isStr(v.message);
    case "truncated": return typeof v.limit === "number";
    default: return false;
  }
}
export function isAppError(v: unknown): v is AppError { return isObj(v) && oneOf(ERROR_KINDS, v.kind) && isStr(v.message); }

export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof Error) return { kind: "internal", message: e.message };
  return { kind: "internal", message: String(e) };
}
