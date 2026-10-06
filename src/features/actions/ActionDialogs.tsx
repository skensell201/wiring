import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { NodeId } from "../../shared/ipc/types";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { ForwardDialog } from "../forward/ForwardDialog";
import { describeId, desiredReplicas, hpaFor, MAX_REPLICAS } from "./actionKinds";

/** Whichever action dialog the store has open. Escape closes it from `useGlobalKeys`. */
export function ActionDialogs() {
  const dialog = useAppStore((s) => s.actionDialog);
  if (!dialog) return null;
  if (dialog.type === "scale") return <ScaleDialog nodeId={dialog.nodeId} />;
  if (dialog.type === "restart") return <RestartDialog nodeId={dialog.nodeId} />;
  if (dialog.type === "forward") return <ForwardDialog nodeId={dialog.nodeId} />;
  return <RollbackDialog nodeId={dialog.nodeId} revision={dialog.revision} />;
}

function ScaleDialog({ nodeId }: { nodeId: NodeId }) {
  const { nodes, edges, tooLarge, scaleObject, close, busy } = useAppStore(useShallow((s) => ({
    nodes: s.nodes, edges: s.edges, tooLarge: s.tooLarge !== null, scaleObject: s.scaleObject, close: s.closeActionDialog, busy: s.actionBusy,
  })));
  const known = nodes.has(nodeId);
  const hpa = useMemo(() => hpaFor(nodeId, edges.values(), nodes), [nodeId, edges, nodes]);
  // Seeded once: later graph updates must not overwrite what the user is typing. Without the node
  // (the graph is too large, or it is not there) the current count is unknown: no guess is seeded.
  const [value, setValue] = useState(() => (known ? String(desiredReplicas(nodes.get(nodeId))) : ""));
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.select(); }, []);

  const n = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= MAX_REPLICAS;
  const step = (d: number) => setValue(String(Math.min(MAX_REPLICAS, Math.max(0, (Number.isInteger(n) ? n : 0) + d))));

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80">
      <form role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-[440px] rounded-card border border-border bg-elevated p-8"
        onSubmit={(e) => { e.preventDefault(); if (valid && !busy) void scaleObject(nodeId, n); }}>
        <h2 id={titleId} className="mb-4 text-2xl font-semibold leading-[1.33] text-text-hi">Scale {describeId(nodeId)}</h2>
        {!known && (
          <p role="note" className="mb-4 rounded-xl border border-border px-3 py-2 text-sm text-text-dim">
            Current replicas and HPA unknown{tooLarge ? " while the graph is too large" : ""}.
          </p>
        )}
        {hpa && (
          <p role="note" className="mb-4 rounded-xl border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-sm text-status-warn">
            Managed by HPA <code className="font-mono">{hpa.name}</code>{hpa.min !== null ? ` (min ${hpa.min}, max ${hpa.max})` : ""} — it will override this value.
          </p>
        )}
        <div className="mb-6 flex items-center gap-2 text-sm text-text-dim">
          <span className="mr-2">Replicas</span>
          <Button aria-label="Decrease replicas" onClick={() => step(-1)}>−</Button>
          <input ref={inputRef} type="number" aria-label="Replicas" min={0} max={MAX_REPLICAS} step={1} value={value} required
            onChange={(e) => setValue(e.target.value)}
            className="w-24 rounded-xl border border-border-strong bg-transparent px-3 py-1.5 text-text-hi tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-accent" />
          <Button aria-label="Increase replicas" onClick={() => step(1)}>+</Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>Apply</Button>
        </div>
      </form>
    </div>
  );
}

function RestartDialog({ nodeId }: { nodeId: NodeId }) {
  const { restartObject, close, busy } = useAppStore(useShallow((s) => ({ restartObject: s.restartObject, close: s.closeActionDialog, busy: s.actionBusy })));
  return (
    <ConfirmDialog open title={`Restart ${describeId(nodeId)}?`} body="Its pods are replaced according to the rollout strategy." busy={busy}
      confirmLabel="Restart" onConfirm={() => void restartObject(nodeId)} onCancel={close} />
  );
}

function RollbackDialog({ nodeId, revision }: { nodeId: NodeId; revision: number }) {
  const { rollbackObject, close, busy } = useAppStore(useShallow((s) => ({ rollbackObject: s.rollbackObject, close: s.closeActionDialog, busy: s.actionBusy })));
  return (
    <ConfirmDialog open title={`Roll ${describeId(nodeId)} back to revision ${revision}?`}
      body="The pod template of that revision is applied and a rollout starts." confirmLabel="Rollback" busy={busy}
      onConfirm={() => void rollbackObject(nodeId, revision)} onCancel={close} />
  );
}
