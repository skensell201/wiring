import { commands } from "../shared/ipc/commands";
import { listenAll } from "../shared/ipc/events";
import { disconnectedState, useAppStore } from "./store";

/** Subscribe backend events to the store. Returns an unsubscribe function. */
export function wireEvents(): Promise<() => void> {
  const s = () => useAppStore.getState();
  return listenAll({
    graph_snapshot: (g) => s().applySnapshot(g),
    graph_delta: (d) => s().applyDelta(d),
    object_events: ({ nodeId, events }) => s().setObjectEvents(nodeId, events),
    connection_state: (state) => {
      s().setConnectionState(state);
      // A connect in flight tears the old session down first; that "disconnected" is its own to
      // resolve (success writes the new connection, failure resets), so leave the store alone.
      if (state === "disconnected" && !s().connection.busy) useAppStore.setState(disconnectedState(s()));
    },
    connection_error: (err) => {
      s().toast(err);
      if (err.kind === "forbidden" || err.kind === "notFound") {
        void commands.deniedKinds().then((kinds) => useAppStore.setState({ deniedKinds: new Set(kinds) })).catch(() => {});
      }
    },
  });
}
