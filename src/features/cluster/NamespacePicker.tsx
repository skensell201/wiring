import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";

export function NamespacePicker() {
  const { namespaces, scope, selectNamespace } = useAppStore(
    useShallow((s) => ({ namespaces: s.connection.namespaces, scope: s.connection.scope, selectNamespace: s.selectNamespace })),
  );
  // Task 12 turns this into a multi-select; until then it shows a one-namespace scope.
  const namespace = Array.isArray(scope) && scope.length === 1 ? scope[0] : null;
  const [draft, setDraft] = useState("");
  const choose = (ns: string) => {
    if (!ns) return;
    void selectNamespace(ns); // the store remembers it for the context
  };
  const cls = "no-drag h-9 rounded-xl border border-border-strong bg-transparent px-3 text-sm font-medium text-text-hi outline-none focus:border-accent";
  if (namespaces.length === 0) {
    return (
      <input aria-label="Namespace" className={cls} placeholder="namespace…" value={draft}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") choose(draft.trim()); }} />
    );
  }
  return (
    <select aria-label="Namespace" className={cls} value={namespace ?? ""} onChange={(e) => choose(e.target.value)}>
      <option value="" disabled>namespace…</option>
      {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
    </select>
  );
}
