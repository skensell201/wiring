import type { ComponentProps } from "react";

/** `primary` is Signal Green, rationed to the one action a screen is asking for (apply, save);
 *  `accent` is the brand's Lavender, for the action a bar offers but a dialog does not ask for
 *  (the header's Create); `danger` confirms a destructive one; everything else is a ghost. */
export function Button({ variant = "ghost", className = "", ...rest }: ComponentProps<"button"> & { variant?: "primary" | "accent" | "ghost" | "danger" }) {
  const base = "no-drag rounded-xl px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50";
  const look = variant === "primary" ? "bg-primary text-black hover:bg-[#33f791]"
    : variant === "accent" ? "bg-accent text-black hover:brightness-110"
    : variant === "danger" ? "bg-status-err text-black hover:bg-[#ff7353]"
    : "border border-border-strong bg-transparent text-text-hi hover:bg-surface";
  return <button type="button" className={`${base} ${look} ${className}`} {...rest} />;
}
