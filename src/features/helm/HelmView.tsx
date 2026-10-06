import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { scopeLabel } from "../../shared/scope";
import type { HelmReleaseDetails, NodeId, Status } from "../../shared/ipc/types";
import { headingFromId } from "../details/DetailsPanel";
import { kindLabel } from "../graph/kindMeta";

const STATUS_TEXT: Record<Status, string> = { ok: "text-status-ok", warn: "text-status-warn", err: "text-status-err", unknown: "text-text-muted" };
const TABS = ["overview", "values", "history", "notes", "resources"] as const;
type HelmTab = (typeof TABS)[number];
const TAB_LABEL: Record<HelmTab, string> = { overview: "Overview", values: "Values", history: "History", notes: "Notes", resources: "Resources" };
const CELL = "border-b border-border px-5";
const HEAD = "h-11 border-b border-border px-5 text-left text-xs font-medium text-text-muted";

const when = (t: string | null) => {
  if (!t) return "—";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleString();
};

/** Helm releases of the scope (read-only, from Helm 3 storage Secrets) and the selected one's tabs. */
export function HelmView() {
  const { releases, selected, details, search, scope, namespaces, selectRelease, clearRelease, select } = useAppStore(
    useShallow((s) => ({
      releases: s.helmReleases, selected: s.helmSelected, details: s.helmDetails, search: s.search,
      scope: s.connection.scope, namespaces: s.connection.namespaces,
      selectRelease: s.selectRelease, clearRelease: s.clearRelease, select: s.select,
    })),
  );
  const [tab, setTab] = useState<HelmTab>("overview");
  useEffect(() => setTab("overview"), [selected?.namespace, selected?.name]);
  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () => (releases ?? []).filter((r) => q === "" || `${r.namespace}/${r.name} ${r.chart}`.toLowerCase().includes(q)),
    [releases, q],
  );

  let message: string | null = null;
  if (!scope) message = "Select a namespace to see its releases.";
  else if (releases === null) message = "Loading Helm releases…";
  else if (releases.length === 0) message = `No Helm releases in ${scopeLabel(scope, namespaces)}`;
  else if (rows.length === 0) message = `No releases match “${search.trim()}”`;

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto bg-space px-8 py-6">
      {rows.length > 0 && (
        <table role="grid" aria-label="Helm releases" className="w-full border-separate border-spacing-0 rounded-card border border-border bg-surface text-sm">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>{["Name", "Namespace", "Chart", "App version", "Revision", "Status", "Updated"].map((h) => <th key={h} scope="col" className={HEAD}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isSelected = selected?.namespace === r.namespace && selected.name === r.name;
              return (
                <tr key={`${r.namespace}/${r.name}`} aria-selected={isSelected} tabIndex={0}
                  onClick={() => void selectRelease(r.namespace, r.name)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    void selectRelease(r.namespace, r.name);
                  }}
                  className={`h-12 cursor-default outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${isSelected ? "bg-muted/50" : "hover:bg-muted/25"}`}>
                  <td className={`${CELL} text-text-hi`}>{r.name}</td>
                  <td className={CELL}>{r.namespace}</td>
                  <td className={CELL}>{r.chart}</td>
                  <td className={CELL}>{r.appVersion || "—"}</td>
                  <td className={`${CELL} tabular-nums`}>{r.revision}</td>
                  <td data-status={r.health} className={`${CELL} ${STATUS_TEXT[r.health]}`}>{r.status}</td>
                  <td className={CELL}>{when(r.updated)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {message && <div className="grid flex-1 place-items-center text-text-muted">{message}</div>}
      {selected && (
        <section aria-label="Release details" className="shrink-0 rounded-card border border-border bg-surface">
          <div className="flex h-12 items-center gap-6 border-b border-border px-6">
            <div role="tablist" className="flex h-full gap-6">
              {TABS.map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                  className={`-mb-px border-b-2 px-1 text-sm font-medium ${tab === t ? "border-accent text-text-hi" : "border-transparent text-text-muted hover:text-text-hi"}`}>
                  {TAB_LABEL[t]}
                </button>
              ))}
            </div>
            <span className="ml-auto text-sm font-medium text-text-hi">{selected.name}</span>
            <button type="button" aria-label="Close release" onClick={clearRelease} className="text-text-muted hover:text-text-hi">
              <X className="size-4" />
            </button>
          </div>
          <div className="max-h-[50vh] overflow-auto p-6 text-sm">
            {!details ? <div className="text-text-muted">Loading…</div> : <ReleaseTab tab={tab} details={details} onOpen={(id) => void select(id)} />}
          </div>
        </section>
      )}
    </div>
  );
}

function ReleaseTab({ tab, details, onOpen }: { tab: HelmTab; details: HelmReleaseDetails; onOpen: (id: NodeId) => void }) {
  const r = details.release;
  switch (tab) {
    case "overview":
      return (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          {([
            ["Chart", r.chart], ["App version", r.appVersion || "—"], ["Revision", String(r.revision)], ["Status", r.status],
            ["Description", details.description || "—"], ["First deployed", when(details.firstDeployed)], ["Last deployed", when(details.lastDeployed)],
          ] as const).map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-text-muted">{k}</dt><dd className="selectable text-text">{v}</dd></div>
          ))}
        </dl>
      );
    case "values":
      return details.values
        ? <pre className="selectable whitespace-pre-wrap font-mono text-xs text-text">{details.values}</pre>
        : <div className="text-text-muted">No user-supplied values</div>;
    case "notes":
      return details.notes
        ? <pre className="selectable whitespace-pre-wrap font-mono text-xs text-text">{details.notes}</pre>
        : <div className="text-text-muted">No notes</div>;
    case "history":
      return (
        <table className="w-full text-left text-sm">
          <thead><tr>{["Revision", "Chart", "App version", "Status", "Updated", "Description"].map((h) => <th key={h} className="pb-2 text-xs font-medium text-text-muted">{h}</th>)}</tr></thead>
          <tbody>
            {details.history.map((h) => (
              <tr key={h.revision} className="h-9">
                <td className="tabular-nums">{h.revision}</td><td>{h.chart}</td><td>{h.appVersion || "—"}</td>
                <td data-status={h.health} className={STATUS_TEXT[h.health]}>{h.status}</td><td>{when(h.updated)}</td><td>{h.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "resources":
      return details.resources.length === 0 ? (
        <div className="text-text-muted">None of the release's objects are in the selected namespaces</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {details.resources.map((id) => {
            const h = headingFromId(id);
            return (
              <li key={id}>
                <button type="button" onClick={() => onOpen(id)} className="text-left text-text hover:text-text-hi">
                  {h.kind ? kindLabel(id, h.kind) : ""} {h.name}{h.namespace ? <span className="text-text-muted"> · {h.namespace}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      );
  }
}
