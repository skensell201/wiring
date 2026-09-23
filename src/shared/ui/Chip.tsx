import type { ButtonHTMLAttributes } from "react";

export function Chip({ active, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`no-drag rounded-full border border-border px-3 py-1 text-xs font-medium transition-colors ${
        active ? "bg-surface text-text-hi" : "bg-space text-text-muted hover:text-text"
      } ${className}`}
      {...rest}
    />
  );
}
