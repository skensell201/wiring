import type { ReactNode } from "react";

/** Small uppercase caption above a Navigator section. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-text-muted">{children}</div>;
}
