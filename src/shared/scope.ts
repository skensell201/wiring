import type { NamespaceScope } from "./ipc/types";

/** The header/caption text for a scope; `null` before any selection. */
export function scopeLabel(scope: NamespaceScope | null, known: string[]): string | null {
  if (scope === null) return null;
  if (scope === "all") return known.length > 0 ? `All namespaces (${known.length})` : "All namespaces";
  return scope.join(", ");
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
