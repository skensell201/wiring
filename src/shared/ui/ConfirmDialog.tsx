import { useEffect, useId, useRef } from "react";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  /** A destructive action: the confirm button is ember. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A modal yes/no question. Escape cancels; Cancel holds the focus on open so Enter never confirms by accident. */
export function ConfirmDialog({ open, title, body, confirmLabel, danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // handled here; the global Escape handler must not act on it as well
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80 backdrop-blur-sm">
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="w-[420px] rounded-card border border-border bg-surface p-6">
        <h2 id={titleId} className="mb-2 text-lg text-text-hi">{title}</h2>
        <p className="mb-5 text-sm text-text-muted">{body}</p>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "primary" : "ghost"} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
