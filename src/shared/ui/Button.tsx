import type { ComponentProps } from "react";

/** `primary` is Cosmic Lilac and reserved for the one high-value action on screen; `danger` confirms a destructive one. */
export function Button({ variant = "ghost", className = "", ...rest }: ComponentProps<"button"> & { variant?: "primary" | "ghost" | "danger" }) {
  const base = "no-drag rounded-lg px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50";
  const look = variant === "primary" ? "border border-white/15 bg-lilac text-text-hi hover:bg-[#62499a]"
    : variant === "danger" ? "border border-white/15 bg-status-err text-text-hi hover:bg-[#c02519]"
    : "border border-border bg-transparent text-text-hi hover:bg-surface";
  return <button type="button" className={`${base} ${look} ${className}`} {...rest} />;
}
