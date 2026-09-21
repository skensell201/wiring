import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { KINDS, type GraphNode, type Kind, type NodeId } from "../../shared/ipc/types";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { KIND_META } from "../graph/kindMeta";
import { LogsTab } from "../logs/LogsTab";
import { EventsTab } from "./EventsTab";
import { OverviewTab } from "./OverviewTab";
import { YamlTab } from "./YamlTab";

type Tab = "overview" | "yaml" | "events" | "logs";
const MIN = 120, MAX = 600, DEFAULT = 280;
/** Kinds with container logs to stream: a Pod's own, or the merged logs of a workload's pods. */
const LOG_KINDS: ReadonlySet<Kind> = new Set<Kind>(["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "PodGroup"]);

/** Name, kind and namespace of an object from its id alone, for a selection that is not a graph
 *  node (a pod collapsed into a PodGroup, a hidden single ReplicaSet). Ids are `Kind/ns/name`,
 *  `Kind/name` for cluster-scoped kinds and `PodGroup/ns/OwnerKind/owner` for groups. */
export function headingFromId(id: NodeId): { name: string; kind: Kind | null; namespace: string | null } {
  const [head, ...rest] = id.split("/");
  const kind = (KINDS as readonly string[]).includes(head) ? (head as Kind) : null;
  if (rest.length === 0) return { name: id, kind: null, namespace: null };
  if (rest.length === 1) return { name: rest[0], kind, namespace: null };
  return { name: rest[rest.length - 1], kind, namespace: rest[0] };
}

/** The delete confirmation for `id`: a PodGroup names its member count (the controller brings
 *  them back), anything else is gone for good. */
function deleteWording(id: NodeId, node: GraphNode | undefined): { title: string; body: string } {
  const h = headingFromId(id);
  if (h.kind === "PodGroup") {
    const [, , ownerKind, owner] = id.split("/");
    const count = node?.group?.count ?? 0;
    return { title: `Delete ${count} ${count === 1 ? "pod" : "pods"} of ${ownerKind} ${owner}?`, body: "The controller will recreate them." };
  }
  const label = h.kind ? `${KIND_META[h.kind].label} ` : "";
  return { title: `Delete ${label}${h.name}?`, body: "This cannot be undone." };
}

export function DetailsPanel() {
  const { details, selectedId, node, requestDelete } = useAppStore(useShallow((s) => ({
    details: s.details, selectedId: s.selectedId, node: s.selectedId ? s.nodes.get(s.selectedId) : undefined, requestDelete: s.requestDelete,
  })));
  const [tab, setTab] = useState<Tab>("overview");
  const [height, setHeight] = useState(DEFAULT);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { startY: e.clientY, startH: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [height]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    setHeight(Math.min(MAX, Math.max(MIN, drag.current.startH + (drag.current.startY - e.clientY))));
  }, []);
  const onPointerUp = useCallback(() => { drag.current = null; }, []);

  useEffect(() => { setTab("overview"); }, [details?.nodeId]);

  const heading = node ? { name: node.name, kind: node.kind, namespace: node.namespace } : selectedId ? headingFromId(selectedId) : null;
  const tabs: { id: Tab; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "yaml", label: "YAML" }, { id: "events", label: "Events" }];
  if (heading?.kind && LOG_KINDS.has(heading.kind)) tabs.push({ id: "logs", label: "Logs" });

  return (
    <section className="shrink-0 border-t border-border bg-panel" style={{ height: collapsed ? 36 : height }}>
      <div className="h-1.5 cursor-row-resize hover:bg-current-b/40" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      <div className="flex h-[30px] items-center gap-1 border-b border-border px-2">
        <div role="tablist" className="flex gap-1">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={`rounded-md px-2.5 py-0.5 text-xs ${tab === t.id ? "bg-muted text-text-hi" : "text-text-muted hover:text-text"}`}>
              {t.label}
            </button>
          ))}
        </div>
        {heading && (
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="text-text-hi">{heading.name}</span>
            {heading.kind && <span className="text-text-muted">{KIND_META[heading.kind].label}{heading.namespace ? ` · ${heading.namespace}` : ""}</span>}
          </div>
        )}
        {selectedId && (
          <button type="button" title="Delete" aria-label="Delete" onClick={() => requestDelete(selectedId)}
            className="ml-1 rounded-md p-1 text-text-muted hover:bg-muted hover:text-status-err">
            <Trash2 className="size-3.5" />
          </button>
        )}
        <button type="button" className="ml-1 text-xs text-text-muted hover:text-text-hi" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand panel" : "Collapse panel"}>
          {collapsed ? "▴" : "▾"}
        </button>
      </div>
      {!collapsed && (
        <div className="h-[calc(100%-36px)]">
          {!details ? (
            <div className="grid h-full place-items-center text-sm text-text-muted">Select a node to see details</div>
          ) : details.loading || !details.data ? (
            <div className="grid h-full place-items-center text-sm text-text-muted">{details.loading ? "Loading…" : "Details unavailable"}</div>
          ) : tab === "overview" ? (
            <OverviewTab data={details.data} />
          ) : tab === "yaml" ? (
            <YamlTab />
          ) : tab === "logs" ? (
            <LogsTab />
          ) : (
            <EventsTab events={details.events} />
          )}
        </div>
      )}
      <DeleteDialog />
      <DiscardDialog />
    </section>
  );
}

function DeleteDialog() {
  const { dialog, node, confirmDelete, cancelDelete } = useAppStore(useShallow((s) => ({
    dialog: s.deleteDialog, node: s.deleteDialog.nodeId ? s.nodes.get(s.deleteDialog.nodeId) : undefined, confirmDelete: s.confirmDelete, cancelDelete: s.cancelDelete,
  })));
  const { title, body } = dialog.nodeId ? deleteWording(dialog.nodeId, node) : { title: "", body: "" };
  return <ConfirmDialog open={dialog.open} title={title} body={body} confirmLabel="Delete" danger onConfirm={() => void confirmDelete()} onCancel={cancelDelete} />;
}

function DiscardDialog() {
  const { open, name, confirmDiscard, cancelDiscard } = useAppStore(useShallow((s) => ({
    open: s.discardDialog.open, name: s.details ? headingFromId(s.details.nodeId).name : "", confirmDiscard: s.confirmDiscard, cancelDiscard: s.cancelDiscard,
  })));
  return (
    <ConfirmDialog open={open} title="Discard your edits?" body={`Your changes to ${name} will be lost.`} confirmLabel="Discard" danger
      onConfirm={confirmDiscard} onCancel={cancelDiscard} />
  );
}
