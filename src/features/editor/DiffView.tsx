import { diffLines } from "diff";
import { useMemo } from "react";

type Mark = "add" | "del" | "same";

const PREFIX: Record<Mark, string> = { add: "+ ", del: "- ", same: "  " };
const TINT: Record<Mark, string> = { add: "bg-status-ok/15 text-status-ok", del: "bg-status-err/15 text-status-err", same: "text-text-muted" };

/** Split a hunk into its lines, dropping the trailing empty string a final newline leaves. */
function lines(value: string): string[] {
  const out = value.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

/** A unified line diff of `original` → `next`, headed by the number of changed lines. */
export function DiffView({ original, next }: { original: string; next: string }) {
  const rows = useMemo(() => {
    const out: { mark: Mark; text: string }[] = [];
    for (const part of diffLines(original, next)) {
      const mark: Mark = part.added ? "add" : part.removed ? "del" : "same";
      for (const text of lines(part.value)) out.push({ mark, text });
    }
    return out;
  }, [original, next]);
  const changed = rows.filter((r) => r.mark !== "same").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-1.5 text-xs text-text-muted">
        {changed === 0 ? "No changes" : `${changed} ${changed === 1 ? "line" : "lines"} changed`}
      </div>
      <pre className="selectable min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-5">
        {rows.map((r, i) => (
          <div key={i} data-testid="diff-line" data-diff={r.mark} className={TINT[r.mark]}>{PREFIX[r.mark]}{r.text}</div>
        ))}
      </pre>
    </div>
  );
}
