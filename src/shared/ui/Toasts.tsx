import { X } from "lucide-react";
import { useEffect } from "react";
import { useAppStore } from "../../app/store";

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => dismiss(toasts[0].id), 8000);
    return () => clearTimeout(t);
  }, [toasts, dismiss]);
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-30 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role="alert" className="pointer-events-auto flex items-start gap-2 rounded-card border border-border bg-surface p-3 text-sm shadow-[0_0_8px_rgba(0,0,0,.26)]">
          <span className={`mt-1 size-2 shrink-0 rounded-full ${t.kind === "info" ? "bg-current-b" : "bg-status-err"}`} />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">{t.kind}</div>
            <div className="break-words text-text-hi">{t.message}</div>
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-text-muted hover:text-text-hi"><X className="size-4" /></button>
        </div>
      ))}
    </div>
  );
}
