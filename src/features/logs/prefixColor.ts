/** Railway's accents first, then muted tints of the ANSI colours in `theme.css`, all legible on Black Hole. */
const PALETTE = ["#bf92ec", "#42946e", "#a05fcf", "#d9b36c", "#8f9bea", "#7fb8c4", "#9fc8a8", "#d0cfd2"];

/** A stable colour per pod name for the `[pod/container]` prefix (spec §5). */
export function prefixColor(pod: string): string {
  let h = 0;
  for (let i = 0; i < pod.length; i++) h = (h * 31 + pod.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
