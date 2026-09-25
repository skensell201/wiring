/** Doppler's accents (Lavender Spark, Signal Green, Plasma Pink) first, then the ANSI tints in `theme.css`; all legible on Shadow Plum. */
const PALETTE = ["#b997ff", "#00f575", "#ff9efa", "#ffb547", "#8fa8ff", "#7fdbe4", "#d0c9c4", "#c9b8ff"];

/** A stable colour per pod name for the `[pod/container]` prefix (spec §5). */
export function prefixColor(pod: string): string {
  let h = 0;
  for (let i = 0; i < pod.length; i++) h = (h * 31 + pod.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
