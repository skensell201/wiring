import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/Button";

export interface EmptyAction { label: string; onClick: () => void }

/** A centre-pane state: an icon, what happened in a sentence or two, and up to two ways forward.
 *  `overlay` floats it over the graph, where only the card itself takes pointer events. */
export function EmptyState({ icon: Icon, title, children, primary, secondary, spinning = false, overlay = false }: {
  icon: LucideIcon; title: string; children?: ReactNode; primary?: EmptyAction; secondary?: EmptyAction; spinning?: boolean; overlay?: boolean;
}) {
  const outer = overlay
    ? "pointer-events-none absolute inset-0 grid place-items-center p-8"
    : "grid h-full w-full place-items-center bg-space px-8 py-6";
  return (
    <div className={outer}>
      <section aria-label={title} aria-busy={spinning || undefined} className="pointer-events-auto flex max-w-lg flex-col items-center gap-3 text-center">
        <Icon aria-hidden className={`size-8 text-accent ${spinning ? "motion-safe:animate-spin" : ""}`} />
        <h2 className="text-lg font-medium text-text-hi">{title}</h2>
        {children !== undefined && <div className="text-sm text-text-muted">{children}</div>}
        {(primary || secondary) && (
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            {primary && <Button variant="primary" onClick={primary.onClick}>{primary.label}</Button>}
            {secondary && <Button onClick={secondary.onClick}>{secondary.label}</Button>}
          </div>
        )}
      </section>
    </div>
  );
}
