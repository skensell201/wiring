/** A single debounced timer for table refreshes, shared by `wireEvents` (which schedules a
 *  refresh when a `graph_delta` touches the open table's kind) and the store (which cancels a
 *  pending refresh when the namespace changes or the session disconnects, so a stale fetch never
 *  lands after its kind or namespace stopped being current).
 *
 *  This lives in its own module rather than either of those two so neither has to import the
 *  other just for this: `store.ts` only needs `cancelTableRefresh`, `wireEvents.ts` needs both,
 *  and neither file needs to know about the other's internals. */

export const TABLE_REFRESH_DEBOUNCE_MS = 300;

let timer: ReturnType<typeof setTimeout> | null = null;

/** Debounce `run` by `ms` (trailing), replacing any refresh already pending. */
export function scheduleTableRefresh(run: () => void, ms: number = TABLE_REFRESH_DEBOUNCE_MS): void {
  cancelTableRefresh();
  timer = setTimeout(() => {
    timer = null;
    run();
  }, ms);
}

/** Drop a pending debounced refresh, if any. */
export function cancelTableRefresh(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
