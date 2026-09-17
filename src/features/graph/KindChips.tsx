import type { Kind } from "../../shared/ipc/types";
import { Chip } from "../../shared/ui/Chip";
import { CHIP_KINDS, KIND_META } from "./kindMeta";

export function KindChips({ hidden, denied, present, onToggle }: { hidden: Set<Kind>; denied: Set<Kind>; present: Set<Kind>; onToggle: (k: Kind) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CHIP_KINDS.map((kind) => {
        const isDenied = denied.has(kind);
        const has = present.has(kind) || (kind === "Pod" && present.has("PodGroup"));
        return (
          <Chip
            key={kind}
            active={!hidden.has(kind)}
            title={isDenied ? "No access (RBAC)" : undefined}
            className={`${has ? "" : "opacity-50"} ${isDenied ? "line-through" : ""}`}
            onClick={() => onToggle(kind)}
          >
            {KIND_META[kind].short}
          </Chip>
        );
      })}
    </div>
  );
}
