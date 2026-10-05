import { ChevronDown, Maximize2, Minimize2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore, type DetailsTab } from "../../app/store";
import { KINDS, type GraphNode, type Kind, type NodeId } from "../../shared/ipc/types";
import { settings } from "../../shared/settings";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { actionsFor, kindOf, ROLLOUT_KINDS } from "../actions/actionKinds";
import { KIND_META } from "../graph/kindMeta";
import { LogsTab } from "../logs/LogsTab";
import { EventsTab } from "./EventsTab";
import { HistoryTab } from "./HistoryTab";
import { OverviewTab } from "./OverviewTab";
import { YamlTab } from "./YamlTab";

type Tab = DetailsTab;
/** Panel height bounds in px: never shorter than `MIN`, always leaving 200 px to the view above. */
const MIN = 200, DEFAULT = 320;
const maxHeight = () => Math.max(MIN, window.innerHeight - 200);
const clampHeight = (h: number) => Math.min(maxHeight(), Math.max(MIN, Math.round(h)));
/** Arrow-key step on the separator; Shift multiplies it. */
const KEY_STEP = 16, KEY_STEP_SHIFT = 64;
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
  const { details, selectedId, node, requestDelete, openActionsMenu, menuOpen, maximized, toggleMaximized, requestedTab, consumeRequestedTab } = useAppStore(useShallow((s) => ({
    details: s.details, selectedId: s.selectedId, node: s.selectedId ? s.nodes.get(s.selectedId) : undefined, requestDelete: s.requestDelete, openActionsMenu: s.openActionsMenu, menuOpen: s.actionsMenu !== null,
    maximized: s.detailsMaximized, toggleMaximized: s.toggleDetailsMaximized,
    requestedTab: s.requestedTab, consumeRequestedTab: s.consumeRequestedTab,
  })));
  const [tab, setTab] = useState<Tab>("overview");
  const [height, setHeight] = useState(DEFAULT);
  // The latest height for pointer-up and keys, so the handlers need not re-bind on every move. It is
  // written synchronously with the state, not from an effect: pointermove renders are continuous-priority
  // and may not have flushed when a quick release fires pointerup, which would then read the previous
  // move's value, snap the panel back one delta and persist the wrong height.
  const heightRef = useRef(height);
  const applyHeight = useCallback((h: number) => { heightRef.current = h; setHeight(h); }, []);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  // The saved height is applied once, clamped to the current window; loading is not a change to save back.
  useEffect(() => {
    let active = true;
    void settings.getDetailsHeight().then((h) => { if (active && h !== null) applyHeight(clampHeight(h)); });
    return () => { active = false; };
  }, [applyHeight]);
  // A shrinking window pulls the panel back into range; the user's chosen height is not overwritten.
  useEffect(() => {
    const onResize = () => applyHeight(clampHeight(heightRef.current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyHeight]);
  /** Applies a user-chosen height and remembers it. */
  const commit = useCallback((h: number) => {
    const next = clampHeight(h);
    applyHeight(next);
    void settings.setDetailsHeight(next);
  }, [applyHeight]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { startY: e.clientY, startH: heightRef.current };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    applyHeight(clampHeight(drag.current.startH + (drag.current.startY - e.clientY)));
  }, [applyHeight]);
  const onPointerUp = useCallback(() => {
    if (!drag.current) return;
    const { startH } = drag.current;
    drag.current = null;
    if (heightRef.current !== startH) commit(heightRef.current); // a click without a move is not a resize
  }, [commit]);
  const onSeparatorKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const step = e.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
    commit(heightRef.current + (e.key === "ArrowUp" ? step : -step));
  }, [commit]);

  useEffect(() => { setTab("overview"); }, [details?.nodeId]);
  // A requested tab (Rollback… → History) wins over the reset above, which runs first in the same commit.
  useEffect(() => {
    if (!requestedTab || !details || details.nodeId !== selectedId) return;
    setTab(requestedTab);
    consumeRequestedTab();
  }, [requestedTab, details?.nodeId, selectedId, consumeRequestedTab]);

  const heading = node ? { name: node.name, kind: node.kind, namespace: node.namespace } : selectedId ? headingFromId(selectedId) : null;
  const tabs: { id: Tab; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "yaml", label: "YAML" }, { id: "events", label: "Events" }];
  if (heading?.kind && LOG_KINDS.has(heading.kind)) tabs.push({ id: "logs", label: "Logs" });
  if (heading?.kind && ROLLOUT_KINDS.has(heading.kind)) tabs.push({ id: "history", label: "History" });

  return (
    // Maximised, the panel fills whatever the column has left under the app header (the view is unmounted by `App`).
    <section data-details-panel className={`border-t border-border bg-panel ${maximized ? "min-h-0 flex-1" : "shrink-0"}`} style={maximized ? undefined : { height }}>
      {maximized ? (
        <div className="h-1.5" />
      ) : (
        <div role="separator" aria-orientation="horizontal" aria-label="Resize details panel" aria-valuenow={height} aria-valuemin={MIN} aria-valuemax={maxHeight()} tabIndex={0}
          className="h-1.5 cursor-row-resize outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
          onKeyDown={onSeparatorKey} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
      )}
      <div className="flex h-12 items-center gap-6 border-b border-border px-6">
        <div role="tablist" className="flex h-full gap-6">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-1 text-sm font-medium transition-colors ${tab === t.id ? "border-accent text-text-hi" : "border-transparent text-text-muted hover:text-text-hi"}`}>
              {t.label}
            </button>
          ))}
        </div>
        {heading && (
          <div className="ml-auto flex items-baseline gap-2">
            <span className="text-sm font-medium text-text-hi">{heading.name}</span>
            {heading.kind && <span className="text-xs text-text-muted">{KIND_META[heading.kind].label}{heading.namespace ? ` · ${heading.namespace}` : ""}</span>}
          </div>
        )}
        {selectedId && actionsFor(kindOf(selectedId)).some((a) => a !== "delete") && (
          <button type="button" aria-label="Actions" aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openActionsMenu(selectedId, r.left, r.bottom + 4, r.top - 4); }}
            className="flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-text-muted hover:bg-surface hover:text-text-hi">
            Actions <ChevronDown className="size-4" />
          </button>
        )}
        {selectedId && (
          <button type="button" title="Delete" aria-label="Delete" onClick={() => requestDelete(selectedId)}
            className="-mr-3 grid size-8 place-items-center rounded-lg text-text-muted hover:bg-surface hover:text-status-err">
            <Trash2 className="size-4" />
          </button>
        )}
        <button type="button" title={maximized ? "Restore panel (Esc)" : "Maximize panel"} aria-label={maximized ? "Restore panel" : "Maximize panel"} onClick={toggleMaximized}
          className={`grid size-8 place-items-center rounded-lg text-text-muted hover:bg-surface hover:text-text-hi ${selectedId ? "" : "ml-auto"}`}>
          {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
      </div>
      <div className="h-[calc(100%-54px)]">
        {!details ? (
          <div className="grid h-full place-items-center text-sm text-text-muted">Select a node to see details</div>
        ) : details.loading || !details.data ? (
          <div className="grid h-full place-items-center text-sm text-text-muted">{details.loading ? "Loading…" : "Details unavailable"}</div>
        ) : tab === "overview" ? (
          <OverviewTab nodeId={details.nodeId} data={details.data} />
        ) : tab === "yaml" ? (
          <YamlTab />
        ) : tab === "logs" ? (
          <LogsTab />
        ) : tab === "history" ? (
          <HistoryTab key={details.nodeId} nodeId={details.nodeId} />
        ) : (
          <EventsTab events={details.events} />
        )}
      </div>
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
