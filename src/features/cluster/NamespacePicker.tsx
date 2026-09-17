import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { settings } from "../../shared/settings";

export function NamespacePicker() {
  const { namespaces, namespace, selectNamespace } = useAppStore(
    useShallow((s) => ({ namespaces: s.connection.namespaces, namespace: s.connection.namespace, selectNamespace: s.selectNamespace })),
  );
  const [draft, setDraft] = useState("");
  const choose = (ns: string) => {
    if (!ns) return;
    void selectNamespace(ns);
    void settings.set("lastNamespace", ns);
  };
  const cls = "no-drag rounded-lg border border-border bg-surface px-2.5 py-1 text-sm text-text-hi outline-none focus:border-current-b";
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
