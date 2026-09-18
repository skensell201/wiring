import { commands } from "../shared/ipc/commands";
import { listenAll } from "../shared/ipc/events";
import type { GraphDelta, Kind } from "../shared/ipc/types";
import { disconnectedState, useAppStore } from "./store";
import { cancelTableRefresh, scheduleTableRefresh } from "./tableRefresh";

/** Whether a delta changes rows that a `kind` table would show. `PodGroup` nodes collapse pods,
 *  so any PodGroup touched by the delta also counts as touching `Pod`. */
export function deltaTouches(delta: GraphDelta, kind: Kind): boolean {
  const matchesKind = (k: string) => k === kind || (kind === "Pod" && k === "PodGroup");
  if (delta.addedNodes.some((n) => matchesKind(n.kind)) || delta.updatedNodes.some((n) => matchesKind(n.kind))) return true;
  return delta.removedNodes.some((id) => matchesKind(id.split("/", 1)[0]));
}

/** Subscribe backend events to the store. Returns an unsubscribe function. */
export function wireEvents(): Promise<() => void> {
  const s = () => useAppStore.getState();
  return listenAll({
    graph_snapshot: (g) => {
      s().applySnapshot(g);
      const view = s().view;
      if (view.name === "table") void s().refreshTable(view.kind);
    },
    graph_delta: (d) => {
      s().applyDelta(d);
      const view = s().view;
      if (view.name === "table" && deltaTouches(d, view.kind)) {
        const kind = view.kind;
        scheduleTableRefresh(() => void useAppStore.getState().refreshTable(kind));
      }
    },
    object_events: ({ nodeId, events }) => s().setObjectEvents(nodeId, events),
    connection_state: (state) => {
      s().setConnectionState(state);
      // A connect in flight tears the old session down first; that "disconnected" is its own to
      // resolve (success writes the new connection, failure resets), so leave the store alone.
      if (state === "disconnected" && !s().connection.busy) {
        cancelTableRefresh();
        useAppStore.setState(disconnectedState(s()));
      }
    },
    connection_error: (err) => {
      s().toast(err);
      if (err.kind === "forbidden" || err.kind === "notFound") {
        void commands.deniedKinds().then((kinds) => useAppStore.setState({ deniedKinds: new Set(kinds) })).catch(() => {});
      }
    },
  });
}
