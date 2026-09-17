import type { Position } from "./layout";

/**
 * SVG path through `points` (at least one): one cubic Bézier per consecutive pair with
 * horizontal control points at half the horizontal distance, so the curve leaves and enters
 * every point flat. Between columns that reads as an S-curve; through a dummy slot the edge
 * passes level, in the empty row the layout reserved for it.
 */
export function pathThrough(points: Position[]): string {
  const [first, ...rest] = points;
  let d = `M ${first.x} ${first.y}`;
  let p = first;
  for (const q of rest) {
    const half = (q.x - p.x) * 0.5;
    d += ` C ${p.x + half} ${p.y}, ${q.x - half} ${q.y}, ${q.x} ${q.y}`;
    p = q;
  }
  return d;
}
