import type { Connection } from "../../app/store";
import type { AppError } from "../../shared/ipc/types";

/** What the centre pane shows instead of the views while there is no session to show. */
export type Pane =
  | { type: "connecting"; context: string }
  | { type: "failed"; context: string; error: AppError }
  | { type: "welcome" }
  | { type: "choose"; contexts: number };

/** The pane for this connection, or `null` when a session is up (the views take over). A connect
 *  in flight wins, even over a session it is replacing; then a failed connect; then, with no
 *  contexts at all, the welcome pane, else the pointer to the navigator. */
export function connectionPane(c: Pick<Connection, "context" | "connecting" | "lastError">, contexts: number): Pane | null {
  if (c.connecting !== null) return { type: "connecting", context: c.connecting };
  if (c.context !== null) return null;
  if (c.lastError) return { type: "failed", context: c.lastError.context, error: c.lastError.error };
  return contexts === 0 ? { type: "welcome" } : { type: "choose", contexts };
}
