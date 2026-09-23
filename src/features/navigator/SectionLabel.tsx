import type { ReactNode } from "react";

/** Caption above a Navigator section. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-1 pt-2 text-xs font-medium tracking-[-0.12px] text-text-muted">{children}</div>;
}
