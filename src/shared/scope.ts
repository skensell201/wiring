import type { NamespaceScope } from "./ipc/types";

/** The header/caption text for a scope (`shop, blog`, `All namespaces (12)`); `null` before any
 *  selection. With `maxNames`, a longer list is cut to `shop, blog +3`. */
export function scopeLabel(scope: NamespaceScope | null, known: string[], maxNames = Infinity): string | null {
  if (scope === null) return null;
  if (scope === "all") return known.length > 0 ? `All namespaces (${known.length})` : "All namespaces";
  const head = scope.slice(0, maxNames).join(", ");
  return scope.length > maxNames ? `${head} +${scope.length - maxNames}` : head;
}

/** Several namespaces on screen: lanes in the graph, a Namespace column in tables. */
export function isMulti(scope: NamespaceScope | null): boolean {
  return scope === "all" || (scope !== null && scope.length > 1);
}

export function inScope(scope: NamespaceScope | null, namespace: string): boolean {
  return scope === "all" || (scope !== null && scope.includes(namespace));
}

/** Where **+ Create** puts an object by default: the first selected namespace (the first known one for All). */
export function firstNamespace(scope: NamespaceScope | null, known: string[]): string | null {
  if (scope === null) return null;
  if (scope === "all") return known[0] ?? null;
  return scope[0] ?? null;
}

/** The scope to reopen after connecting: the remembered one, minus namespaces that are gone (All
 *  only with the permission to list namespaces), else the `fallback` namespace, else none. */
export function restoredScope(remembered: NamespaceScope | null, namespaces: string[], canListNamespaces: boolean, fallback: string | null): NamespaceScope | null {
  const known = (ns: string) => namespaces.length === 0 || namespaces.includes(ns);
  if (remembered === "all" && namespaces.length > 0 && canListNamespaces) return "all";
  if (Array.isArray(remembered)) {
    const kept = remembered.filter(known);
    if (kept.length > 0) return kept;
  }
  return fallback ? [fallback] : null;
}

/** The scope text a table shows in its empty states: `null` until a scope is selected (even a
 *  cluster-scoped kind is only watched once one is), "The cluster" for a cluster-scoped kind. */
export function scopeText(scope: NamespaceScope | null, known: string[], clusterScoped: boolean): string | null {
  const label = scopeLabel(scope, known);
  return label === null ? null : clusterScoped ? "The cluster" : label;
}

/** The "Choose a namespace" sentence, shared by the graph and the tables. */
export function noNamespaceBody(canListNamespaces: boolean): string {
  return canListNamespaces
    ? "Pick one or more namespaces to see their resources."
    : "You can't list namespaces on this cluster. Type the name of one you have access to.";
}
