import { CircleAlert, Clock, KeyRound, LoaderCircle, Network, ShieldAlert, Unplug, WifiOff, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { EmptyState } from "../../shared/EmptyState";
import type { AppError, KubeconfigSource } from "../../shared/ipc/types";
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
    case "connecting":
      return <EmptyState icon={LoaderCircle} spinning title={`Connecting to ${pane.context}…`}>Waiting for the cluster to answer…</EmptyState>;
    case "failed":
      return <FailurePane context={pane.context} error={pane.error} />;
    case "welcome":
      return <WelcomePane />;
    case "choose":
      return <ChoosePane count={pane.contexts} />;
  }
}

function WelcomePane() {
  const { sources, loadKubeconfigSources, rescanKubeconfigs } = useAppStore(useShallow((s) => ({
    sources: s.kubeconfigSources, loadKubeconfigSources: s.loadKubeconfigSources, rescanKubeconfigs: s.rescanKubeconfigs,
  })));
  const add = useAddKubeconfig();
  useEffect(() => {
    if (sources === null) void loadKubeconfigSources();
  }, [sources, loadKubeconfigSources]);
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

function ChoosePane({ count }: { count: number }) {
  const { sidebarCollapsed, toggleSidebar } = useAppStore(useShallow((s) => ({ sidebarCollapsed: s.sidebarCollapsed, toggleSidebar: s.toggleSidebar })));
  const add = useAddKubeconfig();
  const addAction = { label: "Add kubeconfig…", onClick: () => void add() };
  // The contexts are listed in the navigator; while it is collapsed, opening it comes first.
  const actions = sidebarCollapsed
    ? { primary: { label: "Show navigator", onClick: () => void toggleSidebar() }, secondary: addAction }
    : { primary: addAction };
  return (
    <EmptyState icon={Network} title="Choose a cluster" {...actions}>
      {`Pick one of your ${count} kubeconfig ${count === 1 ? "context" : "contexts"} in the navigator.`}
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
