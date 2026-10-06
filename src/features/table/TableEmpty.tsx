import { Inbox, Layers, LoaderCircle, SearchX, ShieldOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { EmptyState } from "../../shared/EmptyState";
import { noNamespaceBody } from "../graph/graphEmptyState";
import type { TableSituation } from "./tableEmptyState";

/** A table view's empty state. `noun` is what the table lists ("Pods", "certificates");
 *  `onCreate` adds **+ Create** to the empty state; `noAccessBody` replaces the RBAC sentence.
 *  `clusterScoped` tables never offer the namespace picker (namespaces do not change their RBAC). */
export function TableEmpty({ state, noun, onCreate, noAccessBody, clusterScoped = false }: { state: TableSituation; noun: string; onCreate?: () => void; noAccessBody?: string; clusterScoped?: boolean }) {
  const { canList, openNamespacePicker, setSearch } = useAppStore(useShallow((s) => ({
    canList: s.connection.canListNamespaces, openNamespacePicker: s.openNamespacePicker, setSearch: s.setSearch,
  })));
  // Without the right to list namespaces the picker takes a typed name.
  const pickAnother = { label: canList ? "Pick another namespace" : "Enter another namespace", onClick: openNamespacePicker };
  switch (state.type) {
    case "noNamespace":
      return <EmptyState icon={Layers} title="Choose a namespace" primary={{ label: "Choose a namespace", onClick: openNamespacePicker }}>{noNamespaceBody(canList)}</EmptyState>;
    case "noAccess":
      return (
        <EmptyState icon={ShieldOff} title="No access" primary={clusterScoped ? undefined : pickAnother}>
          {noAccessBody ?? (clusterScoped ? `You can't list ${noun} on this cluster (RBAC). Ask your cluster admin.` : `You can't list ${noun} in ${state.scope} (RBAC). Ask your cluster admin, or pick another namespace.`)}
        </EmptyState>
      );
    case "loading":
      return <EmptyState icon={LoaderCircle} spinning title={`Loading ${noun}…`} />;
    case "empty":
      return (
        <EmptyState icon={Inbox} title="Nothing here yet" primary={onCreate ? { label: "+ Create", onClick: onCreate } : clusterScoped ? undefined : pickAnother} secondary={onCreate && !clusterScoped ? pickAnother : undefined}>
          {`${state.scope} has no ${noun}.`}
        </EmptyState>
      );
    case "noMatch":
      return (
        <EmptyState icon={SearchX} title="No matches" primary={{ label: "Clear search", onClick: () => setSearch("") }}>
          {`No ${noun} match “${state.query}”.`}
        </EmptyState>
      );
  }
}
