/** What a key in the terminal does before xterm sees it (pure, so it is testable without xterm). */
export type KeyAction = "pass" | "copy" | "leave" | "swallow";

/**
 * xterm consumes Tab, so Ctrl+Shift+Tab (all platforms) moves focus out of the terminal; it never
 * reaches the shell. ⌘C / Ctrl+Shift+C copy xterm's own selection (the native Copy cannot see it).
 */
export function keyAction(e: KeyboardEvent, hasSelection: boolean): KeyAction {
  if (e.key === "Tab" && e.ctrlKey && e.shiftKey) return e.type === "keydown" ? "leave" : "swallow";
  const copy = e.type === "keydown" && e.key.toLowerCase() === "c" && (e.metaKey || (e.ctrlKey && e.shiftKey));
  return copy && hasSelection ? "copy" : "pass";
}
