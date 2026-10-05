import { useEffect, useId, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { commands } from "../../shared/ipc/commands";
import { toAppError, type NodeId, type PortOption } from "../../shared/ipc/types";
import { Button } from "../../shared/ui/Button";
import { describeId, kindOf } from "../actions/actionKinds";

const inRange = (n: number, min: number) => Number.isInteger(n) && n >= min && n <= 65535;
const field = "rounded-xl border border-border-strong bg-transparent px-3 py-1.5 text-text-hi outline-none focus-visible:ring-1 focus-visible:ring-accent";

/** Pick a remote port of `nodeId` and a local one, then start forwarding. Escape closes it from `useGlobalKeys`. */
export function ForwardDialog({ nodeId }: { nodeId: NodeId }) {
  const { close, startForward } = useAppStore(useShallow((s) => ({ close: s.closeActionDialog, startForward: s.startForward })));
  const [ports, setPorts] = useState<PortOption[] | null>(null);
  const [remote, setRemote] = useState("");
  const [local, setLocal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const isService = kindOf(nodeId) === "Service";

  useEffect(() => {
    let active = true;
    commands.forwardPorts(nodeId).then(
      (p) => { if (!active) return; setPorts(p); if (p[0]) setRemote(String(p[0].port)); },
      (e) => { if (!active) return; setPorts([]); setError(toAppError(e).message); },
    );
    return () => { active = false; };
  }, [nodeId]);

  // A new remote port brings a fresh suggestion; the user can still type over it.
  const remotePort = Number(remote);
  useEffect(() => {
    if (!inRange(remotePort, 1)) return;
    let active = true;
    commands.suggestLocalPort(remotePort).then((p) => { if (active) setLocal(String(p)); }, () => {});
    return () => { active = false; };
  }, [remotePort]);

  const localPort = Number(local);
  const valid = inRange(remotePort, 1) && local.trim() !== "" && inRange(localPort, 1024);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const err = await startForward(nodeId, remotePort, localPort);
    setBusy(false);
    if (err) setError(err.message);
  };

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80">
      <form role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={(e) => void submit(e)}
        className="w-[440px] rounded-card border border-border bg-elevated p-8">
        <h2 id={titleId} className="mb-4 text-2xl font-semibold leading-[1.33] text-text-hi">Port-forward {describeId(nodeId)}</h2>
        {ports === null ? (
          <p className="mb-6 text-sm text-text-muted">Loading ports…</p>
        ) : ports.length === 0 && isService ? (
          <p className="mb-6 text-sm text-text-muted">This Service has no TCP ports.</p>
        ) : (
          <div className="mb-6 grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-3 text-sm text-text-dim">
            <label htmlFor={`${titleId}-remote`}>Remote port</label>
            {ports.length > 0 ? (
              <select id={`${titleId}-remote`} aria-label="Remote port" value={remote} onChange={(e) => setRemote(e.target.value)} className={field}>
                {ports.map((p) => <option key={p.port} value={p.port}>{p.label}</option>)}
              </select>
            ) : (
              <input id={`${titleId}-remote`} aria-label="Remote port" type="number" min={1} max={65535} value={remote}
                onChange={(e) => setRemote(e.target.value)} placeholder="container port" className={`w-32 ${field}`} />
            )}
            <label htmlFor={`${titleId}-local`}>Local port</label>
            <input id={`${titleId}-local`} aria-label="Local port" type="number" min={1024} max={65535} value={local}
              onChange={(e) => setLocal(e.target.value)} className={`w-32 tabular-nums ${field}`} />
          </div>
        )}
        {error && <p role="alert" className="mb-4 break-words text-sm text-status-err">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>Start</Button>
        </div>
      </form>
    </div>
  );
}
