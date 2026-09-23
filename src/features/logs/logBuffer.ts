import type { LogLine } from "../../shared/ipc/types";

export interface BufferedLine extends LogLine { seq: number }

/** Bounded line store kept outside zustand: a chatty pod must not re-render the whole app.
 *  Consumers subscribe (one notification per animation frame) and read `lines()` snapshots. */
export class LogBuffer {
  private buf: BufferedLine[] = [];
  private snapshot: BufferedLine[] | null = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  private scheduled = false;

  constructor(private readonly capacity = 10_000) {}

  append(lines: LogLine[]): void {
    if (lines.length === 0) return;
    for (const l of lines) this.buf.push({ ...l, seq: ++this.seq });
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    this.invalidate();
  }

  clear(): void {
    this.buf = [];
    this.invalidate();
  }

  /** The same array until the buffer changes, as useSyncExternalStore requires. */
  lines(): BufferedLine[] {
    return (this.snapshot ??= [...this.buf]);
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private invalidate(): void {
    this.snapshot = null;
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const cb of this.listeners) cb();
    });
  }
}

/** The one buffer behind the Logs tab (one session at a time, spec §5). */
export const logBuffer = new LogBuffer();
