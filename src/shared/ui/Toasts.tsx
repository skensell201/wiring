import { Check, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import { useAppStore, type Toast } from "../../app/store";

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => dismiss(toast.id), 8000);
    return () => clearTimeout(t);
  }, [toast.id, dismiss]);
  const info = toast.kind === "info";
  // Both kinds are elevated cards; only the mark says which one it is.
  const look = "border-border bg-elevated text-text-hi";
  const Icon = info ? Check : TriangleAlert;
  return (
    <div role="alert" className={`pointer-events-auto flex items-start gap-2.5 rounded-toast border px-3.5 py-2.5 text-sm font-medium ${look}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${info ? "text-status-ok" : "text-status-err"}`} />
      <div className="min-w-0 flex-1 break-words">
        {!info && <div className="text-xs font-normal text-text-muted">{toast.kind}</div>}
        {toast.message}
      </div>
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)} className="opacity-70 hover:opacity-100"><X className="size-4" /></button>
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
