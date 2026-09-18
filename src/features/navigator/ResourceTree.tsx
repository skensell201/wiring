import { ChevronDown, ChevronRight, Waypoints } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { kindStats, useAppStore } from "../../app/store";
import type { Kind, Status } from "../../shared/ipc/types";
import { Dot } from "../../shared/ui/Dot";
import { KIND_PLURAL, SECTIONS, type Section } from "./kindTree";
import { SectionLabel } from "./SectionLabel";
import { SECTION_ICONS } from "./sectionIcons";

const ROW = "flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-[13px]";
const ACTIVE = "bg-muted text-text-hi shadow-[inset_2px_0_0_var(--color-ember-a)]";
const IDLE = "text-text hover:bg-muted/50";

/** Overview plus the resource categories, each kind with its live count and worst status. */
export function ResourceTree() {
  const { nodes, view, deniedKinds, showGraph, showTable } = useAppStore(
    useShallow((s) => ({ nodes: s.nodes, view: s.view, deniedKinds: s.deniedKinds, showGraph: s.showGraph, showTable: s.showTable })),
  );
  const stats = useMemo(() => kindStats(nodes), [nodes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const activeKind = view.name === "table" ? view.kind : null;

  return (
    <div className="px-2 pt-3">
      <SectionLabel>Resources</SectionLabel>
      <button type="button" aria-current={view.name === "graph" ? "page" : undefined} onClick={showGraph}
        className={`${ROW} pl-2 ${view.name === "graph" ? ACTIVE : IDLE}`}>
        <Waypoints className="size-3.5 shrink-0 text-text-muted" />
        <span>Overview</span>
      </button>
      {SECTIONS.map((section) => (
        <SectionGroup key={section.id} section={section} open={!collapsed.has(section.id)} onToggle={() => toggle(section.id)}>
          {section.kinds.map((kind) => (
            <KindRow key={kind} kind={kind} active={kind === activeKind} denied={deniedKinds.has(kind)} stat={stats.get(kind)} onClick={() => void showTable(kind)} />
          ))}
        </SectionGroup>
      ))}
    </div>
  );
}

function SectionGroup({ section, open, onToggle, children }: { section: Section; open: boolean; onToggle: () => void; children: ReactNode }) {
  const Icon = SECTION_ICONS[section.id];
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-1">
      <button type="button" aria-expanded={open} onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] uppercase tracking-wider text-text-muted hover:text-text">
        <Chevron className="size-3 shrink-0" />
        {Icon && <Icon className="size-3.5 shrink-0" />}
        <span>{section.label}</span>
      </button>
      {open && children}
    </div>
  );
}

function KindRow({ kind, active, denied, stat, onClick }: {
  kind: Kind; active: boolean; denied: boolean; stat: { count: number; worst: Status } | undefined; onClick: () => void;
}) {
  return (
    <button type="button" aria-current={active ? "page" : undefined} title={denied ? "No access (RBAC)" : undefined} onClick={onClick}
      className={`${ROW} pl-7 ${active ? ACTIVE : IDLE} ${denied ? "line-through text-text-muted" : ""}`}>
      <span className="flex-1 truncate">{KIND_PLURAL[kind]}</span>
      {stat && <span className="font-mono text-xs text-text-muted">{stat.count}</span>}
      {stat && <Dot status={stat.worst} className="size-1.5 shrink-0" />}
    </button>
  );
}
