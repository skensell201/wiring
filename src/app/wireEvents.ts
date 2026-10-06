import { refKey } from "../shared/customId";
import { commands } from "../shared/ipc/commands";
import { listenAll } from "../shared/ipc/events";
import type { GraphDelta, Kind } from "../shared/ipc/types";
import { kindOf, USAGE_KINDS } from "../features/actions/actionKinds";
import { useUpdateStore } from "../features/update/updateStore";
import { disconnectedState, requestDetailsRefresh, useAppStore } from "./store";
import { cancelTableRefresh, scheduleTableRefresh, TABLE_REFRESH_DEBOUNCE_MS } from "./tableRefresh";

/** Its own debounce, not the table one: a release change must not cancel a pending table refresh. */
let helmTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleHelmRefresh(): void {
  if (helmTimer !== null) clearTimeout(helmTimer);
  helmTimer = setTimeout(() => {
    helmTimer = null;
    void useAppStore.getState().refreshHelm();
  }, TABLE_REFRESH_DEBOUNCE_MS);
}

/** Whether a delta changes rows that a `kind` table would show. `PodGroup` nodes collapse pods,
 *  so any PodGroup touched by the delta also counts as touching `Pod`. Single ReplicaSets are
 *  hidden behind their Deployment, so their changes surface as Deployment/Pod deltas. */
export function deltaTouches(delta: GraphDelta, kind: Kind): boolean {
  const matchesKind = (k: string) =>
    k === kind ||
    (kind === "Pod" && k === "PodGroup") ||
    (kind === "ReplicaSet" && (k === "Deployment" || k === "Pod" || k === "PodGroup"));
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
      // A scope switch stopped the custom watch and changed the Secrets Helm reads; re-list both.
      if (view.name === "custom") void s().refreshCustom(view.resource);
      if (view.name === "helm") void s().refreshHelm();
      // A too-large snapshot carries no nodes to diff the open details against; the backend sends
      // one per (debounced) rebuild, so it is the details' cue to reload too.
      if (g.tooLarge) requestDetailsRefresh();
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
    forwards_changed: (forwards) => s().setForwards(forwards),
    update_progress: (p) => useUpdateStore.getState().setProgress(p),
    menu_check_updates: () => void useUpdateStore.getState().check(true),
    // The releases are read from storage Secrets, which are no graph nodes: this is their only
    // change signal. Re-read for the Helm view, or to keep the navigator's count fresh.
    helm_changed: () => {
      if (s().view.name === "helm" || s().helmReleases !== null) scheduleHelmRefresh();
    },
    // Only the table on screen: a late event of a table just left must not resurrect it.
    custom_table: (t) => {
      const view = s().view;
      if (view.name === "custom" && refKey(view.resource) === refKey(t.resource)) s().applyCustomTable(t);
    },
    metrics_updated: () => {
      const view = s().view;
      if (view.name === "table" && USAGE_KINDS.has(view.kind)) {
        const kind = view.kind;
        scheduleTableRefresh(() => {
          // Only the table still on screen: the user may have moved on during the debounce.
          const now = useAppStore.getState().view;
          if (now.name === "table" && now.kind === kind) void useAppStore.getState().refreshTable(kind);
        });
      }
      // Only a Pod or workload has usage rows; the details of anything else would not change.
      const selected = s().selectedId;
      const selectedKind = selected === null ? null : kindOf(selected);
      if (selectedKind && USAGE_KINDS.has(selectedKind)) requestDetailsRefresh();
    },
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
        void Promise.all([commands.deniedKinds(), commands.partialKinds()])
          .then(([denied, partial]) => useAppStore.setState({ deniedKinds: new Set(denied), partialKinds: new Set(partial) }))
          .catch(() => {});
      }
    },
  });
}
