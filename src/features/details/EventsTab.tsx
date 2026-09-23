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
  if (events.length === 0) return <div className="p-6 text-sm text-text-muted">No events.</div>;
  return (
    <div className="h-full overflow-auto selectable">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-panel text-left text-xs font-medium text-text-muted">
          <tr><th className="px-6 py-2.5 font-medium">Type</th><th className="px-3 py-2.5 font-medium">Reason</th><th className="px-3 py-2.5 font-medium">Message</th><th className="px-3 py-2.5 font-medium">Count</th><th className="px-6 py-2.5 font-medium">Age</th></tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.name} data-type={e.type} className={`border-t border-border ${e.type === "Warning" ? "text-status-warn" : "text-text"}`}>
              <td className="px-6 py-2">{e.type}</td>
              <td className="px-3 py-2">{e.reason}</td>
              <td className="px-3 py-2 text-text-hi">{e.message}</td>
              <td className="px-3 py-2">{e.count}</td>
              <td className="px-6 py-2">{age(e.lastTimestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
