import type { ButtonHTMLAttributes } from "react";

export function Chip({ active, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`no-drag rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        active ? "border-current-b bg-muted text-text-hi" : "border-border bg-surface text-text-muted hover:text-text"
      } ${className}`}
      {...rest}
    />
  );
}
