import { CircleAlert, Clock, KeyRound, LoaderCircle, Network, ShieldAlert, Unplug, WifiOff, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import mark from "../../assets/mark.svg";
import { useAppStore } from "../../app/store";
import { EmptyState } from "../../shared/EmptyState";
import type { AppError, KubeconfigSource } from "../../shared/ipc/types";
import { isLinux } from "../../shared/platform";
import { Button } from "../../shared/ui/Button";
import { useAddKubeconfig } from "../cluster/useAddKubeconfig";
import { describeConnectError, type ConnectCause } from "./describeConnectError";
import type { Pane } from "./panes";

const CAUSE_ICON: Record<ConnectCause, LucideIcon> = {
  helper: KeyRound, credentials: ShieldAlert, certificate: ShieldAlert, timeout: Clock, unreachable: WifiOff, other: CircleAlert,
};
const ORIGIN_LABEL: Record<KubeconfigSource["origin"], string> = { env: "from KUBECONFIG", default: "default location", added: "added in Wiring" };

function sourceStateText(s: KubeconfigSource): string {
  switch (s.state) {
    case "ok": return `${s.contexts} ${s.contexts === 1 ? "context" : "contexts"}`;
    case "missing": return "not found";
    case "invalid": return `can't be read: ${s.error ?? "unknown error"}`;
    case "empty": return "no contexts";
  }
}

/** The centre pane while there is no connected session: welcome, choose, connecting or failed. */
export function ConnectionPane({ pane }: { pane: Pane }) {
  switch (pane.type) {
    case "starting":
      return null; // the contexts load in a blink; anything said here would only flash
    case "connecting":
      return <ConnectingPane context={pane.context} />;
    case "failed":
      return <FailurePane context={pane.context} error={pane.error} />;
    case "welcome":
      return <WelcomePane />;
    case "choose":
      return <ChoosePane count={pane.contexts} />;
  }
}

function ConnectingPane({ context }: { context: string }) {
  // Disconnecting drops the late result of the connect (the store's connect generations).
  const disconnect = useAppStore((s) => s.disconnect);
  return (
    <EmptyState icon={LoaderCircle} spinning title={`Connecting to ${context}…`} secondary={{ label: "Cancel", onClick: () => void disconnect() }}>
      Waiting for the cluster to answer…
    </EmptyState>
  );
}

function WelcomePane() {
  const { sources, loadKubeconfigSources, rescanKubeconfigs } = useAppStore(useShallow((s) => ({
    sources: s.kubeconfigSources, loadKubeconfigSources: s.loadKubeconfigSources, rescanKubeconfigs: s.rescanKubeconfigs,
  })));
  const add = useAddKubeconfig();
  useEffect(() => {
    if (sources === null) void loadKubeconfigSources();
  }, [sources, loadKubeconfigSources]);
  // Linux has no installer to carry the brand, so the first run inside the app does it.
  if (isLinux) {
    return (
      <FirstRunSheet onAdd={() => void add()} onRescan={() => void rescanKubeconfigs()} sources={sources} />
    );
  }
  return (
    <EmptyState icon={Unplug} title="Connect Wiring to a cluster"
      primary={{ label: "Add kubeconfig…", onClick: () => void add() }} secondary={{ label: "Rescan", onClick: () => void rescanKubeconfigs() }}>
      <p>Wiring reads your kubeconfig, the file <code>kubectl</code> uses.</p>
      <p className="mt-3">Kubeconfig files Wiring checked:</p>
      <ul aria-label="Kubeconfig files" className="mt-2 flex flex-col gap-1.5 text-left">
        {(sources ?? []).map((s, i) => (
          <li key={`${i}:${s.path}`} className="rounded-lg border border-border bg-surface px-3 py-2">
            <div className="selectable truncate font-mono text-xs text-text-hi" title={s.path}>{s.path}</div>
            <div className="text-xs">{`${ORIGIN_LABEL[s.origin]} · ${sourceStateText(s)}`}</div>
          </li>
        ))}
        {sources?.length === 0 && <li className="text-xs">No kubeconfig location: KUBECONFIG is empty and there is no home folder.</li>}
      </ul>
    </EmptyState>
  );
}

/** The Linux first run: the mark, one line of what Wiring is, and the way in. Nothing else. */
function FirstRunSheet({ onAdd, onRescan, sources }: {
  onAdd: () => void; onRescan: () => void; sources: KubeconfigSource[] | null;
}) {
  return (
    <div className="grid h-full w-full place-items-center bg-space px-8 py-6">
      <section className="flex max-w-lg flex-col items-center gap-4 text-center">
        <img src={mark} alt="" width={64} height={64} className="select-none"
          style={{ filter: "drop-shadow(0 0 28px rgb(185 151 255 / .35))" }} />
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text-hi">Wiring</h1>
        <p className="max-w-[34ch] text-sm text-text-muted">A Kubernetes IDE that shows how your namespace is wired together.</p>
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          <Button variant="primary" onClick={onAdd}>Add kubeconfig…</Button>
          <Button onClick={onRescan}>Rescan</Button>
        </div>
        <div className="mt-2 w-full text-left text-sm text-text-muted">
          <p>Kubeconfig files Wiring checked:</p>
          <ul aria-label="Kubeconfig files" className="mt-2 flex flex-col gap-1.5">
            {(sources ?? []).map((s, i) => (
              <li key={`${i}:${s.path}`} className="rounded-lg border border-border bg-surface px-3 py-2">
                <div className="selectable truncate font-mono text-xs text-text-hi" title={s.path}>{s.path}</div>
                <div className="text-xs">{`${ORIGIN_LABEL[s.origin]} · ${sourceStateText(s)}`}</div>
              </li>
            ))}
            {sources?.length === 0 && <li className="text-xs">No kubeconfig location: KUBECONFIG is empty and there is no home folder.</li>}
          </ul>
        </div>
      </section>
    </div>
  );
}

function ChoosePane({ count }: { count: number }) {
  const openClusterPicker = useAppStore((s) => s.openClusterPicker);
  const add = useAddKubeconfig();
  // The cluster list lives in the header, so the way in is the header's menu — it is always there,
  // whatever the navigator is doing.
  return (
    <EmptyState icon={Network} title="Choose a cluster"
      primary={{ label: "Choose a cluster", onClick: openClusterPicker }} secondary={{ label: "Add kubeconfig…", onClick: () => void add() }}>
      {`Pick one of your ${count} kubeconfig ${count === 1 ? "context" : "contexts"} from the header.`}
    </EmptyState>
  );
}

function FailurePane({ context, error }: { context: string; error: AppError }) {
  const { retryConnect, dismissConnectError } = useAppStore(useShallow((s) => ({ retryConnect: s.retryConnect, dismissConnectError: s.dismissConnectError })));
  const info = describeConnectError(error);
  return (
    <EmptyState icon={CAUSE_ICON[info.cause]} title={info.title} tone="error" autoFocusPrimary
      primary={{ label: "Retry", onClick: () => void retryConnect() }} secondary={{ label: "Choose another cluster", onClick: () => void dismissConnectError() }}>
      <p>Wiring couldn't connect to <span className="text-text-hi">{context}</span>.</p>
      <p className="selectable mt-2 break-words font-mono text-xs">{info.detail}</p>
      {info.hint && <p className="mt-2">{info.hint}</p>}
    </EmptyState>
  );
}
