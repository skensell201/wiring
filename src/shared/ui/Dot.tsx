import type { ConnectionState, Status } from "../ipc/types";

const COLORS: Record<Status | ConnectionState, string> = {
  ok: "bg-status-ok", warn: "bg-status-warn", err: "bg-status-err", unknown: "bg-status-unknown",
  connected: "bg-status-ok", degraded: "bg-status-warn", disconnected: "bg-status-err",
};

export function Dot({ status, className = "" }: { status: Status | ConnectionState; className?: string }) {
  return <span data-testid="status-dot" data-status={status} className={`inline-block size-2 rounded-full ${COLORS[status]} ${className}`} />;
}
