import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";

export function NamespacePicker() {
  const { namespaces, namespace, selectNamespace } = useAppStore(
    useShallow((s) => ({ namespaces: s.connection.namespaces, namespace: s.connection.namespace, selectNamespace: s.selectNamespace })),
  );
  const [draft, setDraft] = useState("");
  const choose = (ns: string) => {
    if (!ns) return;
    void selectNamespace(ns); // the store remembers it for the context
  };
  const cls = "no-drag h-9 rounded-md border border-border bg-transparent px-3 text-sm font-medium text-text-hi outline-none focus:border-supernova";
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
