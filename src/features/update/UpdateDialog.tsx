import { useEffect, useId, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../../shared/ui/Button";
import { useUpdateStore } from "./updateStore";

const MB = 1024 * 1024;
const mb = (n: number) => (n / MB).toFixed(1);

/** The offered release: notes, then Install and restart (with progress) or Later. */
export function UpdateDialog() {
  const { open, info, current, installing, progress, error, later, install } = useUpdateStore(useShallow((s) => ({
    open: s.dialogOpen, info: s.available, current: s.current, installing: s.installing, progress: s.progress, error: s.error,
    later: s.later, install: s.install,
  })));
  const titleId = useId();
  const installRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (open) installRef.current?.focus(); }, [open]);
  // Capture phase, so this runs before `useGlobalKeys` and marks the Escape as handled.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); later(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, later]);

  if (!open || !info) return null;
  const pct = progress?.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;
  const sub = [current ? `You have ${current}` : null, info.date ? `released ${info.date}` : null].filter(Boolean).join(" · ");

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-[480px] rounded-card border border-border bg-elevated p-8">
        <h2 id={titleId} className="mb-1 text-2xl font-semibold leading-[1.33] text-text-hi">Wiring {info.version} is available</h2>
        {sub && <p className="mb-4 text-sm text-text-muted">{sub}</p>}
        {info.notes && (
          <pre className="selectable mb-6 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3 font-sans text-sm text-text-dim">{info.notes}</pre>
        )}
        {installing && (
          <div className="mb-6">
            <div role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}
              className="h-1.5 overflow-hidden rounded-full bg-surface">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${pct ?? 0}%` }} />
            </div>
            <p className="mt-2 text-xs text-text-muted">
              {progress ? `${mb(progress.downloaded)}${progress.total ? ` / ${mb(progress.total)}` : ""} MB` : "Starting download…"}
            </p>
          </div>
        )}
        {error && <p role="alert" className="mb-6 break-words text-sm text-status-err">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={later} disabled={installing}>Later</Button>
          <Button ref={installRef} variant="primary" disabled={installing} onClick={() => void install()}>
            {error ? "Retry" : "Install and restart"}
          </Button>
        </div>
      </div>
    </div>
  );
}
