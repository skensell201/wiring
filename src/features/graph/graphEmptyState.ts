import { KINDS, type GraphNode, type Kind, type NamespaceScope, type NodeId, type TooLarge } from "../../shared/ipc/types";
import { CLUSTER_SCOPED } from "../../shared/kinds";
import { isMulti, scopeLabel } from "../../shared/scope";
import { matchesSearch } from "./toFlow";

/** The cluster-scoped kinds plus the synthetic ones, which a namespace's RBAC does not decide about. */
const NOT_NAMESPACED = new Set<Kind>([...CLUSTER_SCOPED, "PodGroup", "Custom"]);
/** The watched kinds a namespace's RBAC decides about. */
export const NAMESPACED_KINDS: Kind[] = KINDS.filter((k) => !NOT_NAMESPACED.has(k));

export type GraphSituation =
  | { type: "noNamespace"; canListNamespaces: boolean }
  | { type: "loading"; scope: string }
  /** `canNarrow`: the scope has several namespaces, so picking fewer is a way out. */
  | { type: "tooLarge"; count: number; scope: string; canNarrow: boolean }
  | { type: "noAccess"; scope: string }
  /** `restricted`: some kinds are denied or only partly listed, so "empty" may not be the whole story. */
  | { type: "empty"; scope: string; restricted: boolean }
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
  partialKinds: Set<Kind>;
  /** Whether `deniedKinds`/`partialKinds` are known for this scope yet. */
  deniedLoaded: boolean;
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
  if (i.tooLarge) return { type: "tooLarge", count: i.tooLarge.nodes, scope, canNarrow: isMulti(i.scope) };
  if (i.nodes.size === 0) {
    // Denied kinds arrive after the snapshot; until then "empty" might really be "no access".
    if (!i.deniedLoaded) return { type: "loading", scope };
    if (NAMESPACED_KINDS.every((k) => i.deniedKinds.has(k))) return { type: "noAccess", scope };
    return { type: "empty", scope, restricted: i.deniedKinds.size > 0 || i.partialKinds.size > 0 };
  }
  // One pass, no allocation: this runs on every canvas render.
  const query = i.search.trim();
  let anyVisible = false;
  for (const n of i.nodes.values()) {
    if (i.hiddenKinds.has(n.kind)) continue;
    if (query === "" || matchesSearch(n, query)) return null;
    anyVisible = true;
  }
  return anyVisible ? { type: "noMatch", query } : { type: "allHidden" };
}
