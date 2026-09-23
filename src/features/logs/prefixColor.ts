const PALETTE = ["#67e8f9", "#c084fc", "#2ecc71", "#fd8925", "#5aa9ff", "#f472b6", "#fde047", "#2dd4bf"];

/** A stable colour per pod name for the `[pod/container]` prefix (spec §5). */
export function prefixColor(pod: string): string {
  let h = 0;
  for (let i = 0; i < pod.length; i++) h = (h * 31 + pod.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
