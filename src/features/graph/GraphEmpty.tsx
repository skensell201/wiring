import { EyeOff, Inbox, Layers, LoaderCircle, Network, SearchX, ShieldOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { EmptyState } from "../../shared/EmptyState";
import { noNamespaceBody } from "../../shared/scope";
import type { GraphSituation } from "./graphEmptyState";

/** The graph's empty state, floated over the (empty) canvas. */
export function GraphEmpty({ state }: { state: GraphSituation }) {
  const a = useAppStore(useShallow((s) => ({
    openNamespacePicker: s.openNamespacePicker, openCreate: s.openCreate, showAllKinds: s.showAllKinds,
    setSearch: s.setSearch, showTable: s.showTable, lastTableKind: s.lastTableKind,
    canListNamespaces: s.connection.canListNamespaces,
  })));
  const pick = (label: string) => ({ label, onClick: a.openNamespacePicker });
  // Without the right to list namespaces the picker takes a typed name.
  const another = pick(a.canListNamespaces ? "Pick another namespace" : "Enter another namespace");
  switch (state.type) {
    case "noNamespace":
      return <EmptyState overlay icon={Layers} title="Choose a namespace" primary={pick("Choose a namespace")}>{noNamespaceBody(state.canListNamespaces)}</EmptyState>;
    case "loading":
      return <EmptyState overlay spinning icon={LoaderCircle} title={`Loading ${state.scope}…`} />;
    case "tooLarge": {
      const openTables = { label: "Open tables", onClick: () => void a.showTable(a.lastTableKind ?? "Deployment") };
      const count = `${state.count.toLocaleString("en-US")} objects in ${state.scope}.`;
      // One namespace cannot be narrowed: the tables are the way out.
      return state.canNarrow ? (
        <EmptyState overlay icon={Network} title="Too many objects to draw" primary={pick("Pick fewer namespaces")} secondary={openTables}>
          {`${count} Use the tables, or pick fewer namespaces.`}
        </EmptyState>
      ) : (
        <EmptyState overlay icon={Network} title="Too many objects to draw" primary={openTables}>
          {`${count} Use the tables.`}
        </EmptyState>
      );
    }
    case "noAccess":
      return (
        <EmptyState overlay icon={ShieldOff} title="No access" primary={another}>
          {`You can't list any resources in ${state.scope} (RBAC). Ask your cluster admin, or pick another namespace.`}
        </EmptyState>
      );
    case "empty":
      return (
        <EmptyState overlay icon={Inbox} title="Nothing here yet" primary={{ label: "+ Create", onClick: () => a.openCreate() }} secondary={another}>
          {`${state.scope} has no resources.${state.restricted ? " Some kinds are hidden from you (RBAC)." : ""}`}
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
