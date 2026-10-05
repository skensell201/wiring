import type { GraphNode, NodeId } from "../../shared/ipc/types";

/** The longest cause chain followed; the backend only links downwards, this guards the UI anyway. */
export const MAX_PATH = 8;

/** `id` and the nodes its problem's `cause` chain leads to, ending at the root cause.
 *  Empty when `id` has no problem; stops at a missing node, a node without a problem or a repeat. */
export function problemPath(id: NodeId, nodes: Map<NodeId, GraphNode>): NodeId[] {
  const path: NodeId[] = [];
  let current: NodeId | null = id;
  while (current !== null && path.length < MAX_PATH && !path.includes(current)) {
    const node = nodes.get(current);
    if (!node?.problem) break;
    path.push(current);
    current = node.problem.cause;
  }
  return path;
}
