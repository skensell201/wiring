import { commands } from "../shared/ipc/commands";
import { listenAll } from "../shared/ipc/events";
import { initialState, useAppStore } from "./store";

/** Subscribe backend events to the store. Returns an unsubscribe function. */
export function wireEvents(): Promise<() => void> {
  const s = () => useAppStore.getState();
  return listenAll({
    graph_snapshot: (g) => s().applySnapshot(g),
    graph_delta: (d) => s().applyDelta(d),
    object_events: ({ nodeId, events }) => s().setObjectEvents(nodeId, events),
    connection_state: (state) => {
      s().setConnectionState(state);
      if (state === "disconnected") {
        useAppStore.setState({ ...initialState(), contexts: s().contexts, hiddenKinds: s().hiddenKinds, pickerOpen: true });
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
