import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toSpans } from "./ansi";
import { logBuffer, type BufferedLine } from "./logBuffer";
import { prefixColor } from "./prefixColor";

/** A stream that could not be read (`error` state), shown as a line above the log. */
export interface Problem { key: string; message: string }

interface Props {
  query: string;
  /** Index (into the matches) of the current match; the view scrolls to it. */
  current: number;
  wrap: boolean;
  showPrefix: boolean;
  problems: Problem[];
  onMatches: (count: number) => void;
}

const ROW = 22;

/** Identity of row `index`: the stream key for a problem row, the line's `seq` for a log row.
 *  The virtualiser caches a measured height per key, so keying by index would hand a line the
 *  height of the one it displaced once the ring buffer saturates. */
export function rowKey(problems: Problem[], lines: BufferedLine[], index: number): string | number {
  if (index < problems.length) return `p:${problems[index].key}`;
  return lines[index - problems.length]?.seq ?? index;
}

const subscribe = (cb: () => void) => logBuffer.subscribe(cb);
const snapshot = () => logBuffer.lines();

/** One row per line, virtualised; sticks to the bottom until the user scrolls up. */
export function LogView({ query, current, wrap, showPrefix, problems, onMatches }: Props) {
  const lines = useSyncExternalStore(subscribe, snapshot);
  const parentRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const q = query.toLowerCase();
  // Memoised so the scroll-to-match effect does not refire on every unrelated render.
  const matches = useMemo(() => {
    if (!q) return [];
    const out: number[] = [];
    lines.forEach((l, i) => { if (l.text.toLowerCase().includes(q)) out.push(i); });
    return out;
  }, [lines, q]);
  useEffect(() => onMatches(matches.length), [matches.length, onMatches]);
  // Read by the scroll-to-match effect, which must fire on user actions only: `matches` is a new
  // array per frame while streaming and would re-pin the view on every batch.
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const total = problems.length + lines.length;
  const virtualizer = useVirtualizer({
    count: total, getScrollElement: () => parentRef.current, estimateSize: () => ROW, overscan: 30, initialRect: { width: 800, height: 400 },
    getItemKey: (index) => rowKey(problems, lines, index),
  });

  // A saturated buffer drops as many lines as it gains, so `total` stops changing: the last
  // line's `seq` is what says a batch arrived.
  const lastSeq = lines.length ? lines[lines.length - 1].seq : 0;
  useEffect(() => {
    if (stuck && total > 0) virtualizer.scrollToIndex(total - 1, { align: "end" });
  }, [total, lastSeq, stuck, virtualizer]);
  useEffect(() => {
    const idx = matchesRef.current[current];
    if (idx !== undefined) { setStuck(false); virtualizer.scrollToIndex(problems.length + idx, { align: "center" }); }
  }, [current, q, problems.length, virtualizer]);
  // Rows are measured (wrapping changes their height); a wrap toggle invalidates every measurement.
  useEffect(() => { virtualizer.measure(); }, [wrap, virtualizer]);

  const onScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    setStuck(el.scrollTop + el.clientHeight >= el.scrollHeight - ROW);
  };

  return (
    <div className="relative h-full">
      <div ref={parentRef} data-testid="log-view" onScroll={onScroll}
        className={`selectable h-full overflow-auto px-5 py-3 font-mono text-base leading-[22px] text-text-dim ${wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const style = { position: "absolute" as const, top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` };
            if (item.index < problems.length) {
              const p = problems[item.index];
              return <div key={rowKey(problems, lines, item.index)} ref={virtualizer.measureElement} data-index={item.index} style={style} className="text-status-warn">{p.key} — {p.message}</div>;
            }
            const line = lines[item.index - problems.length];
            const isMatch = q !== "" && line.text.toLowerCase().includes(q);
            const isCurrent = matches[current] === item.index - problems.length;
            return (
              <div key={rowKey(problems, lines, item.index)} ref={virtualizer.measureElement} data-index={item.index} style={style} data-testid={isMatch ? "match" : undefined} className={isCurrent ? "bg-accent/35 text-text-hi" : isMatch ? "bg-accent/15" : ""}>
                {showPrefix && <span style={{ color: prefixColor(line.pod) }}>[{line.pod}/{line.container}]</span>}{showPrefix && " "}
                <Line text={line.text} />
              </div>
            );
          })}
        </div>
      </div>
      {!stuck && (
        <button type="button" onClick={() => { setStuck(true); virtualizer.scrollToIndex(total - 1, { align: "end" }); }}
          className="absolute bottom-3 right-4 rounded-xl border border-border-strong bg-elevated px-3 py-1.5 text-xs font-medium text-text-hi hover:bg-muted">
          ↓ Follow
        </button>
      )}
    </div>
  );
}

/** A line's text: an RFC 3339 stamp (from `timestamps`) dimmed, the rest ANSI-coloured. */
function Line({ text }: { text: string }) {
  const stamp = /^(\d{4}-\d\d-\d\dT[^ ]+) (.*)$/s.exec(text);
  const spans = toSpans(stamp ? stamp[2] : text);
  return (
    <>
      {stamp && <span className="text-text-muted">{stamp[1]} </span>}
      {spans.map((s, i) => (s.className ? <span key={i} className={s.className}>{s.text}</span> : <span key={i}>{s.text}</span>))}
    </>
  );
}

export type { BufferedLine };
