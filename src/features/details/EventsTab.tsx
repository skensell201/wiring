import type { K8sEvent } from "../../shared/ipc/types";

function age(ts: string | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function EventsTab({ events }: { events: K8sEvent[] }) {
  if (events.length === 0) return <div className="p-4 text-sm text-text-muted">No events.</div>;
  return (
    <div className="h-full overflow-auto selectable">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-panel text-left text-[10px] uppercase tracking-wider text-text-muted">
          <tr><th className="px-4 py-2">Type</th><th className="px-2 py-2">Reason</th><th className="px-2 py-2">Message</th><th className="px-2 py-2">Count</th><th className="px-4 py-2">Age</th></tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.name} data-type={e.type} className={`border-t border-border ${e.type === "Warning" ? "text-status-warn" : "text-text"}`}>
              <td className="px-4 py-1.5">{e.type}</td>
              <td className="px-2 py-1.5">{e.reason}</td>
              <td className="px-2 py-1.5 text-text-hi">{e.message}</td>
              <td className="px-2 py-1.5">{e.count}</td>
              <td className="px-4 py-1.5">{age(e.lastTimestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
