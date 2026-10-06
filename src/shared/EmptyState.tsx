import type { LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./ui/Button";

export interface EmptyAction { label: string; onClick: () => void }

/** A centre-pane state: an icon, what happened in a sentence or two, and up to two ways forward.
 *  `tone="error"` announces it as an alert, otherwise politely as a status.
 *  `overlay` floats it over the graph, where only the card itself takes pointer events.
 *  `autoFocusPrimary` moves focus to the primary action when the state appears. */
export function EmptyState({ icon: Icon, title, children, primary, secondary, spinning = false, overlay = false, tone = "info", autoFocusPrimary = false }: {
  icon: LucideIcon; title: string; children?: ReactNode; primary?: EmptyAction; secondary?: EmptyAction; spinning?: boolean; overlay?: boolean; tone?: "info" | "error"; autoFocusPrimary?: boolean;
}) {
  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const hasPrimary = primary !== undefined;
  useEffect(() => {
    if (autoFocusPrimary && hasPrimary) primaryRef.current?.focus();
  }, [autoFocusPrimary, hasPrimary]);
  const outer = overlay
    ? "pointer-events-none absolute inset-0 grid place-items-center p-8"
    : "grid h-full w-full place-items-center bg-space px-8 py-6";
  return (
    <div className={outer}>
      <section role={tone === "error" ? "alert" : "status"} aria-labelledby={titleId} aria-busy={spinning || undefined} className="pointer-events-auto flex max-w-lg flex-col items-center gap-3 text-center">
        <Icon aria-hidden className={`size-8 text-accent ${spinning ? "motion-safe:animate-spin" : ""}`} />
        <h2 id={titleId} className="break-words text-lg font-medium text-text-hi">{title}</h2>
        {children != null && <div className="break-words text-sm text-text-muted">{children}</div>}
        {(primary || secondary) && (
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            {primary && <Button ref={primaryRef} variant="primary" onClick={primary.onClick}>{primary.label}</Button>}
            {secondary && <Button onClick={secondary.onClick}>{secondary.label}</Button>}
          </div>
        )}
      </section>
    </div>
  );
}
