import { KINDS, type GraphNode, type Kind, type NamespaceScope, type NodeId, type TooLarge } from "../../shared/ipc/types";
import { scopeLabel } from "../../shared/scope";
import { matchesSearch, visibleNodes } from "./toFlow";

/** Cluster-scoped kinds (their RBAC does not depend on the scope) and the synthetic ones. */
const NOT_NAMESPACED = new Set<Kind>(["PersistentVolume", "ClusterRole", "ClusterRoleBinding", "Node", "PodGroup", "Custom"]);
/** The watched kinds a namespace's RBAC decides about. */
export const NAMESPACED_KINDS: Kind[] = KINDS.filter((k) => !NOT_NAMESPACED.has(k));

/** The "Choose a namespace" sentence, shared by the graph and the tables. */
export function noNamespaceBody(canListNamespaces: boolean): string {
  return canListNamespaces
    ? "Pick one or more namespaces to see their resources."
    : "You can't list namespaces on this cluster. Type the name of one you have access to.";
}

export type GraphSituation =
  | { type: "noNamespace"; canListNamespaces: boolean }
  | { type: "loading"; scope: string }
  | { type: "tooLarge"; count: number; scope: string }
  | { type: "noAccess"; scope: string }
  | { type: "empty"; scope: string }
  | { type: "allHidden" }
  | { type: "noMatch"; query: string };

export interface GraphEmptyInput {
  context: string | null;
  scope: NamespaceScope | null;
  namespaces: string[];
  canListNamespaces: boolean;
  graphReady: boolean;
  tooLarge: TooLarge | null;
  deniedKinds: Set<Kind>;
  nodes: Map<NodeId, GraphNode>;
  hiddenKinds: Set<Kind>;
  search: string;
}

/** Why the graph has nothing to draw, in priority order, or `null` when it has something. Not
 *  connected, connecting and a failed connect belong to the connection pane (`connectionPane`),
 *  which replaces the views, so this starts at a connected session. */
export function graphEmptyState(i: GraphEmptyInput): GraphSituation | null {
  if (i.context === null) return null;
  if (i.scope === null) return { type: "noNamespace", canListNamespaces: i.canListNamespaces };
  const scope = scopeLabel(i.scope, i.namespaces) ?? "";
  if (!i.graphReady) return { type: "loading", scope };
  if (i.tooLarge) return { type: "tooLarge", count: i.tooLarge.nodes, scope };
  if (NAMESPACED_KINDS.every((k) => i.deniedKinds.has(k))) return { type: "noAccess", scope };
  if (i.nodes.size === 0) return { type: "empty", scope };
  const visible = visibleNodes(i.nodes, i.hiddenKinds);
  if (visible.length === 0) return { type: "allHidden" };
  const query = i.search.trim();
  if (query !== "" && !visible.some((n) => matchesSearch(n, query))) return { type: "noMatch", query };
  return null;
}
