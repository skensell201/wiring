import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { Section } from "./kindTree";
import { SECTION_ICONS } from "./sectionIcons";

export const ROW = "flex h-8 w-full items-center gap-2.5 rounded-lg pr-3 text-left text-sm";
export const ACTIVE = "inset-hairline bg-surface text-text-hi";
export const IDLE = "text-text-dim hover:bg-surface hover:text-text-hi";

/** A collapsible navigator section; `action` sits to the right of its header (e.g. a refresh button). */
export function SectionGroup({ section, open, onToggle, action, children }: {
  section: Pick<Section, "id" | "label">; open: boolean; onToggle: () => void; action?: ReactNode; children: ReactNode;
}) {
  const Icon = SECTION_ICONS[section.id];
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-3">
      <div className="flex items-center">
        <button type="button" aria-expanded={open} onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-1 text-xs font-medium text-text-muted hover:text-text">
          <Chevron className="size-3 shrink-0" />
          {Icon && <Icon className="size-3.5 shrink-0" />}
          <span className="truncate">{section.label}</span>
        </button>
        {action}
      </div>
      {open && children}
    </div>
  );
}
