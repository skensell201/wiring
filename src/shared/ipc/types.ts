// Mirrors of the Rust payload types. Keep in sync with src/shared/ipc/fixtures/*.json
// and docs/ipc-contract.md. Runtime guards are deliberately shallow: they check
// shapes and enum values, not every optional field.

export const KINDS = [
  "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod", "Service", "Ingress",
  "ConfigMap", "Secret", "PersistentVolumeClaim", "PersistentVolume", "ServiceAccount", "HorizontalPodAutoscaler",
  "NetworkPolicy", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "Node",
  "PodGroup", "Custom",
] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = ["ok", "warn", "err", "unknown"] as const;
export type Status = (typeof STATUSES)[number];

export const RELATIONS = ["owns", "selects", "routes", "mounts", "envFrom", "claims", "binds", "usesSA", "scales", "applies", "allows", "grants", "subject", "runsOn"] as const;
export type Relation = (typeof RELATIONS)[number];

export const ERROR_KINDS = ["auth", "network", "forbidden", "notFound", "conflict", "invalid", "internal"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const CONNECTION_STATES = ["connected", "degraded", "disconnected"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type NodeId = string;

export interface GroupInfo { count: number; ok: number; warn: number; err: number }

/** Why a node is yellow or red; `cause` names the neighbour to blame (see docs/ipc-contract.md#problems). */
export interface Problem { reason: string; message: string | null; cause: NodeId | null }

export interface GraphNode {
  id: NodeId;
  kind: Kind;
  namespace: string | null;
  name: string;
  status: Status;
  badges: string[];
  group: GroupInfo | null;
  /** Present only on warn/err nodes. */
  problem?: Problem;
}

export interface GraphEdge { id: string; source: NodeId; target: NodeId; relation: Relation }

/** Which namespaces the session watches: all of them, or a non-empty list. */
export type NamespaceScope = "all" | string[];

export interface KindStat { kind: Kind; count: number; worst: Status }
/** Sent instead of the nodes of a graph with more than 1 500 nodes. */
export interface TooLarge { nodes: number; kinds: KindStat[] }

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; tooLarge?: TooLarge }

export interface GraphDelta {
  addedNodes: GraphNode[];
  updatedNodes: GraphNode[];
  removedNodes: NodeId[];
  addedEdges: GraphEdge[];
  removedEdges: string[];
}

export interface ContextInfo { name: string; cluster: string; user: string; namespace: string | null; sourceFile: string }
/** `canListNamespaces` is false when `namespaces` is only the context namespace (listing was forbidden): no "All namespaces" then. */
export interface ConnectInfo { context: string; serverVersion: string; namespaces: string[]; canListNamespaces: boolean }
export interface ObjectDetails { yaml: string; summary: [string, string][]; related: NodeId[] }
export interface K8sEvent {
  name: string; type: string; reason: string; message: string; count: number;
  firstTimestamp: string | null; lastTimestamp: string | null;
}

export const SOURCE_ORIGINS = ["env", "default", "added"] as const;
export const SOURCE_STATES = ["ok", "missing", "invalid", "empty"] as const;
/** One kubeconfig path Wiring reads, with what it held (see docs/ipc-contract.md#kubeconfig-sources). */
export interface KubeconfigSource {
  path: string;
  origin: (typeof SOURCE_ORIGINS)[number];
  state: (typeof SOURCE_STATES)[number];
  contexts: number;
  error: string | null;
}
export interface ObjectEvents { nodeId: NodeId; events: K8sEvent[] }
export interface AppError { kind: ErrorKind; message: string }

export interface TableColumn { key: string; label: string; numeric: boolean }
export interface TableCell { text: string; status: Status | null }
export interface TableRow { nodeId: NodeId; status: Status; cells: TableCell[] }
export interface Table { kind: Kind; columns: TableColumn[]; rows: TableRow[] }

/** A custom kind as the dynamic API addresses it (`group` is empty for the core group). */
export interface ResourceRef { group: string; version: string; kind: string; plural: string; namespaced: boolean }
export interface PrinterColumn { name: string; jsonPath: string; type: string }
export interface CustomKind { resource: ResourceRef; columns: PrinterColumn[] }
/** `list_custom`'s answer and the `custom_table` event: the rows of one custom kind. */
export interface CustomTable {
  resource: ResourceRef; table: Table;
  /** Null except on the last `custom_table` event of a table whose watch ended for good; the rows are then empty. */
  error: string | null;
}

export interface HelmRelease {
  name: string; namespace: string; chart: string; appVersion: string; revision: number;
  /** Helm's own status (`deployed`, `failed`, `pending-upgrade`, …); `health` is its colour. */
  status: string; health: Status; updated: string | null;
}
export interface HelmRevision { revision: number; chart: string; appVersion: string; status: string; health: Status; updated: string | null; description: string }
export interface HelmReleaseDetails {
  release: HelmRelease; description: string; firstDeployed: string | null; lastDeployed: string | null;
  values: string; notes: string; history: HelmRevision[]; resources: NodeId[];
}

export interface LogLine { pod: string; container: string; text: string }
export type LogMessage =
  | { type: "lines"; sessionId: number; lines: LogLine[] }
  | { type: "started"; sessionId: number; pod: string; container: string }
  | { type: "ended"; sessionId: number; pod: string; container: string }
  | { type: "error"; sessionId: number; pod: string; container: string; message: string }
  | { type: "truncated"; sessionId: number; limit: number };

export interface ExecPod { name: string; containers: string[] }
export type ExecMessage =
  | { type: "output"; sessionId: number; data: string }
  | { type: "ended"; sessionId: number; code: number | null; message: string | null }
  | { type: "error"; sessionId: number; message: string };
export interface ExecRequest { nodeId: NodeId; pod: string; container: string; cols: number; rows: number }

export interface LogRequest { nodeId: NodeId; container: string | null; previous: boolean; timestamps: boolean }

export interface Revision {
  revision: number;
  current: boolean;
  createdAt: string | null;
  changeCause: string | null;
  images: string[];
  /** The revision's pod template as YAML. */
  template: string;
}

export const METRICS_STATES = ["pending", "available", "unavailable", "forbidden"] as const;
export type MetricsState = (typeof METRICS_STATES)[number];
/** Payload of `metrics_updated`: a new metrics-server sample (or the API's absence) for the namespace. */
export interface MetricsUpdate { state: MetricsState }

export const FORWARD_STATUSES = ["active", "noReadyPod", "podGone", "error"] as const;
export type ForwardStatus = (typeof FORWARD_STATUSES)[number];

/** A running port-forward (docs/ipc-contract.md#port-forward). */
export interface Forward {
  id: number;
  nodeId: NodeId;
  /** "Service web" */
  targetLabel: string;
  remotePort: number;
  localPort: number;
  /** The pod behind the latest connection. */
  pod: string | null;
  status: ForwardStatus;
  message: string | null;
}

export interface PortOption { port: number; label: string }

/** A newer published release (docs/ipc-contract.md#updates). */
export interface UpdateInfo { version: string; date: string | null; notes: string | null }
export interface UpdateCheck { current: string; update: UpdateInfo | null }
export interface UpdateProgress { downloaded: number; total: number | null }

// ---- guards ---------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || typeof v === "number";
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => isStr(v) && (list as readonly string[]).includes(v);
const arrayOf = <T>(v: unknown, g: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(g);

function isProblem(v: unknown): v is Problem {
  return isObj(v) && isStr(v.reason) && isStrOrNull(v.message) && isStrOrNull(v.cause);
}
export function isGraphNode(v: unknown): v is GraphNode {
  return isObj(v) && isStr(v.id) && oneOf(KINDS, v.kind) && isStrOrNull(v.namespace) && isStr(v.name)
    && oneOf(STATUSES, v.status) && arrayOf(v.badges, isStr) && (v.group === null || (isObj(v.group) && typeof v.group.count === "number"))
    && (v.problem === undefined || isProblem(v.problem));
}
export function isGraphEdge(v: unknown): v is GraphEdge {
  return isObj(v) && isStr(v.id) && isStr(v.source) && isStr(v.target) && oneOf(RELATIONS, v.relation);
}
function isKindStat(v: unknown): v is KindStat {
  return isObj(v) && oneOf(KINDS, v.kind) && typeof v.count === "number" && oneOf(STATUSES, v.worst);
}
export function isTooLarge(v: unknown): v is TooLarge {
  return isObj(v) && typeof v.nodes === "number" && arrayOf(v.kinds, isKindStat);
}
export function isGraph(v: unknown): v is Graph {
  return isObj(v) && arrayOf(v.nodes, isGraphNode) && arrayOf(v.edges, isGraphEdge) && (v.tooLarge === undefined || isTooLarge(v.tooLarge));
}
export function isGraphDelta(v: unknown): v is GraphDelta {
  return isObj(v) && arrayOf(v.addedNodes, isGraphNode) && arrayOf(v.updatedNodes, isGraphNode)
    && arrayOf(v.removedNodes, isStr) && arrayOf(v.addedEdges, isGraphEdge) && arrayOf(v.removedEdges, isStr);
}
export function isContextInfo(v: unknown): v is ContextInfo {
  return isObj(v) && isStr(v.name) && isStr(v.cluster) && isStr(v.user) && isStrOrNull(v.namespace) && isStr(v.sourceFile);
}
export function isConnectInfo(v: unknown): v is ConnectInfo {
  return isObj(v) && isStr(v.context) && isStr(v.serverVersion) && arrayOf(v.namespaces, isStr) && typeof v.canListNamespaces === "boolean";
}
export function isKubeconfigSource(v: unknown): v is KubeconfigSource {
  return isObj(v) && isStr(v.path) && oneOf(SOURCE_ORIGINS, v.origin) && oneOf(SOURCE_STATES, v.state)
    && Number.isInteger(v.contexts) && (v.contexts as number) >= 0 && isStrOrNull(v.error);
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
export function isResourceRef(v: unknown): v is ResourceRef {
  return isObj(v) && isStr(v.group) && isStr(v.version) && isStr(v.kind) && isStr(v.plural) && typeof v.namespaced === "boolean";
}
const isPrinterColumn = (v: unknown): v is PrinterColumn => isObj(v) && isStr(v.name) && isStr(v.jsonPath) && isStr(v.type);
export function isCustomKind(v: unknown): v is CustomKind {
  return isObj(v) && isResourceRef(v.resource) && arrayOf(v.columns, isPrinterColumn);
}
export function isCustomTable(v: unknown): v is CustomTable {
  return isObj(v) && isResourceRef(v.resource) && isTable(v.table) && v.table.kind === "Custom" && isStrOrNull(v.error);
}
export function isHelmRelease(v: unknown): v is HelmRelease {
  return isObj(v) && isStr(v.name) && isStr(v.namespace) && isStr(v.chart) && isStr(v.appVersion) && typeof v.revision === "number"
    && isStr(v.status) && oneOf(STATUSES, v.health) && isStrOrNull(v.updated);
}
const isHelmRevision = (v: unknown): v is HelmRevision =>
  isObj(v) && typeof v.revision === "number" && isStr(v.chart) && isStr(v.appVersion) && isStr(v.status)
  && oneOf(STATUSES, v.health) && isStrOrNull(v.updated) && isStr(v.description);
export function isHelmReleaseDetails(v: unknown): v is HelmReleaseDetails {
  return isObj(v) && isHelmRelease(v.release) && isStr(v.description) && isStrOrNull(v.firstDeployed) && isStrOrNull(v.lastDeployed)
    && isStr(v.values) && isStr(v.notes) && arrayOf(v.history, isHelmRevision) && arrayOf(v.resources, isStr);
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
export function isExecPod(v: unknown): v is ExecPod { return isObj(v) && isStr(v.name) && arrayOf(v.containers, isStr); }
export function isExecMessage(v: unknown): v is ExecMessage {
  if (!isObj(v) || typeof v.sessionId !== "number") return false;
  switch (v.type) {
    case "output": return isStr(v.data);
    case "ended": return (v.code === null || typeof v.code === "number") && isStrOrNull(v.message);
    case "error": return isStr(v.message);
    default: return false;
  }
}
export function isRevision(v: unknown): v is Revision {
  return isObj(v) && typeof v.revision === "number" && typeof v.current === "boolean" && isStrOrNull(v.createdAt)
    && isStrOrNull(v.changeCause) && arrayOf(v.images, isStr) && isStr(v.template);
}
export function isMetricsUpdate(v: unknown): v is MetricsUpdate {
  return isObj(v) && oneOf(METRICS_STATES, v.state);
}

export function isForward(v: unknown): v is Forward {
  return isObj(v) && typeof v.id === "number" && isStr(v.nodeId) && isStr(v.targetLabel) && typeof v.remotePort === "number"
    && typeof v.localPort === "number" && isStrOrNull(v.pod) && oneOf(FORWARD_STATUSES, v.status) && isStrOrNull(v.message);
}
export function isPortOption(v: unknown): v is PortOption {
  return isObj(v) && typeof v.port === "number" && isStr(v.label);
}
export function isAppError(v: unknown): v is AppError { return isObj(v) && oneOf(ERROR_KINDS, v.kind) && isStr(v.message); }

export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof Error) return { kind: "internal", message: e.message };
  return { kind: "internal", message: String(e) };
}

export function isUpdateInfo(v: unknown): v is UpdateInfo {
  return isObj(v) && isStr(v.version) && isStrOrNull(v.date) && isStrOrNull(v.notes);
}
export function isUpdateCheck(v: unknown): v is UpdateCheck {
  return isObj(v) && isStr(v.current) && (v.update === null || isUpdateInfo(v.update));
}
export function isUpdateProgress(v: unknown): v is UpdateProgress {
  return isObj(v) && typeof v.downloaded === "number" && isNumOrNull(v.total);
}
