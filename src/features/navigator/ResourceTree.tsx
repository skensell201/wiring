import { Waypoints } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { kindStats, useAppStore } from "../../app/store";
import type { Kind, Status } from "../../shared/ipc/types";
import { Dot } from "../../shared/ui/Dot";
import { CustomSection } from "./CustomSection";
import { HelmSection } from "./HelmSection";
import { KIND_PLURAL, SECTIONS } from "./kindTree";
import { SectionLabel } from "./SectionLabel";
import { ACTIVE, IDLE, ROW, SectionGroup } from "./treeParts";

/** Overview plus the resource categories, each kind with its live count and worst status. */
export function ResourceTree() {
  const { nodes, tooLarge, partialKinds, view, deniedKinds, showGraph, showTable } = useAppStore(
    useShallow((s) => ({ nodes: s.nodes, tooLarge: s.tooLarge, partialKinds: s.partialKinds, view: s.view, deniedKinds: s.deniedKinds, showGraph: s.showGraph, showTable: s.showTable })),
  );
  const stats = useMemo(
    () => (tooLarge ? new Map(tooLarge.kinds.map((k) => [k.kind, { count: k.count, worst: k.worst }])) : kindStats(nodes)),
    [nodes, tooLarge],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const activeKind = view.name === "table" ? view.kind : null;

  return (
    <div className="px-2 pt-4">
      <SectionLabel>Resources</SectionLabel>
      <button type="button" aria-current={view.name === "graph" ? "page" : undefined} onClick={showGraph}
        className={`${ROW} pl-3 ${view.name === "graph" ? ACTIVE : IDLE}`}>
        <Waypoints className={`size-4 shrink-0 ${view.name === "graph" ? "text-accent" : "text-text-muted"}`} />
        <span>Overview</span>
      </button>
      {SECTIONS.map((section) => (
        <SectionGroup key={section.id} section={section} open={!collapsed.has(section.id)} onToggle={() => toggle(section.id)}>
          {section.kinds.map((kind) => (
            <KindRow key={kind} kind={kind} active={kind === activeKind} denied={deniedKinds.has(kind)} partial={partialKinds.has(kind)} stat={stats.get(kind)} onClick={() => void showTable(kind)} />
          ))}
        </SectionGroup>
      ))}
      <CustomSection />
      <HelmSection />
    </div>
  );
}

function KindRow({ kind, active, denied, partial, stat, onClick }: {
  kind: Kind; active: boolean; denied: boolean; partial: boolean; stat: { count: number; worst: Status } | undefined; onClick: () => void;
}) {
  return (
    <button type="button" aria-current={active ? "page" : undefined} title={denied ? "No access (RBAC)" : undefined} onClick={onClick}
      className={`${ROW} pl-8 ${active ? ACTIVE : IDLE} ${denied ? "line-through text-text-muted" : ""}`}>
      <span className="flex-1 truncate">{KIND_PLURAL[kind]}</span>
      {partial && <span className="text-[11px] italic text-text-muted" title="Some namespaces are not readable (RBAC)">partial</span>}
      {stat && <span className="text-xs tabular-nums text-text-muted">{stat.count}</span>}
      {stat && <Dot status={stat.worst} className="size-1.5 shrink-0" />}
    </button>
  );
}
