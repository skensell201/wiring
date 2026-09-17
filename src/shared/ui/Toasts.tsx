import { X } from "lucide-react";
import { useEffect } from "react";
import { useAppStore, type Toast } from "../../app/store";

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), 8000);
    return () => clearTimeout(t);
  }, [toast.id, dismiss]);
  return (
    <div role="alert" className="pointer-events-auto flex items-start gap-2 rounded-card border border-border bg-surface p-3 text-sm shadow-[0_0_8px_rgba(0,0,0,.26)]">
      <span className={`mt-1 size-2 shrink-0 rounded-full ${toast.kind === "info" ? "bg-current-b" : "bg-status-err"}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-text-muted">{toast.kind}</div>
        <div className="break-words text-text-hi">{toast.message}</div>
      </div>
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)} className="text-text-muted hover:text-text-hi"><X className="size-4" /></button>
    </div>
  );
}

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-30 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </div>
  );
}
