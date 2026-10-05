import { listen, type UnlistenFn } from "./tauri";
import type { AppError, ConnectionState, Forward, Graph, GraphDelta, MetricsUpdate, ObjectEvents } from "./types";

export interface BackendEvents {
  graph_snapshot: Graph;
  graph_delta: GraphDelta;
  object_events: ObjectEvents;
  connection_state: ConnectionState;
  connection_error: AppError;
  forwards_changed: Forward[];
  metrics_updated: MetricsUpdate;
}

export type EventHandlers = { [K in keyof BackendEvents]: (payload: BackendEvents[K]) => void };

/** Subscribe to every backend event; returns a function that unsubscribes all. */
export async function listenAll(handlers: EventHandlers): Promise<() => void> {
  const unlisteners: UnlistenFn[] = [];
  for (const name of Object.keys(handlers) as (keyof BackendEvents)[]) {
    unlisteners.push(await listen(name, (e) => handlers[name](e.payload as never)));
  }
  return () => unlisteners.forEach((u) => u());
}
