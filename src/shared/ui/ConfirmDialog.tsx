import { useEffect, useId, useRef } from "react";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  /** A destructive action: the confirm button is red. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A modal yes/no question. Cancel holds the focus on open so Enter never confirms by accident.
 *  Escape cancels from the global key handler (`useGlobalKeys`), which knows which dialog is on top. */
export function ConfirmDialog({ open, title, body, confirmLabel, danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80">
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="w-[440px] rounded-card border border-border bg-surface p-8">
        <h2 id={titleId} className="mb-2 text-2xl font-semibold leading-[1.33] text-text-hi">{title}</h2>
        <p className="mb-6 text-sm text-text-dim">{body}</p>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
