import type { ButtonHTMLAttributes } from "react";

export function Button({ variant = "ghost", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  const base = "no-drag rounded-lg px-3 py-1.5 text-sm transition-opacity disabled:opacity-50";
  const look = variant === "primary" ? "gradient-ember text-text-hi hover:opacity-90" : "border border-border bg-transparent text-text hover:bg-muted";
  return <button type="button" className={`${base} ${look} ${className}`} {...rest} />;
}
