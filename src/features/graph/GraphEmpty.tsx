import { EyeOff, Inbox, Layers, LoaderCircle, Network, SearchX, ShieldOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { EmptyState } from "../../shared/EmptyState";
import { noNamespaceBody, type GraphSituation } from "./graphEmptyState";

/** The graph's empty state, floated over the (empty) canvas. */
export function GraphEmpty({ state }: { state: GraphSituation }) {
  const a = useAppStore(useShallow((s) => ({
    openNamespacePicker: s.openNamespacePicker, openCreate: s.openCreate, showAllKinds: s.showAllKinds,
    setSearch: s.setSearch, showTable: s.showTable, lastTableKind: s.lastTableKind,
  })));
  const pick = (label: string) => ({ label, onClick: a.openNamespacePicker });
  switch (state.type) {
    case "noNamespace":
      return <EmptyState overlay icon={Layers} title="Choose a namespace" primary={pick("Choose a namespace")}>{noNamespaceBody(state.canListNamespaces)}</EmptyState>;
    case "loading":
      return <EmptyState overlay spinning icon={LoaderCircle} title={`Loading ${state.scope}…`} />;
    case "tooLarge":
      return (
        <EmptyState overlay icon={Network} title="Too many objects to draw" primary={pick("Pick fewer namespaces")}
          secondary={{ label: "Open tables", onClick: () => void a.showTable(a.lastTableKind ?? "Deployment") }}>
          {`${state.count.toLocaleString("en-US")} objects in ${state.scope}. Use the tables, or pick fewer namespaces.`}
        </EmptyState>
      );
    case "noAccess":
      return (
        <EmptyState overlay icon={ShieldOff} title="No access" primary={pick("Pick another namespace")}>
          {`You can't list any resources in ${state.scope} (RBAC). Ask your cluster admin, or pick another namespace.`}
        </EmptyState>
      );
    case "empty":
      return (
        <EmptyState overlay icon={Inbox} title="Nothing here yet" primary={{ label: "+ Create", onClick: () => a.openCreate() }} secondary={pick("Pick another namespace")}>
          {`${state.scope} has no resources.`}
        </EmptyState>
      );
    case "allHidden":
      return <EmptyState overlay icon={EyeOff} title="All kinds are hidden" primary={{ label: "Show all kinds", onClick: a.showAllKinds }}>Turn some kinds back on to see the graph.</EmptyState>;
    case "noMatch":
      return (
        <EmptyState overlay icon={SearchX} title="No matches" primary={{ label: "Clear search", onClick: () => a.setSearch("") }}>
          {`Nothing on the graph matches “${state.query}”.`}
        </EmptyState>
      );
  }
}
