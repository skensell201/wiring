import type { NodeId, ResourceRef } from "./ipc/types";

/** `Custom/<group>/<version>/<kind>/<namespace>/<name>`: the node id of a custom resource
 *  (namespace empty for cluster-scoped kinds, group empty for the core group). */
export const CUSTOM_PREFIX = "Custom/";

export interface CustomIdParts { group: string; version: string; kind: string; namespace: string | null; name: string }

export const isCustomId = (id: NodeId): boolean => id.startsWith(CUSTOM_PREFIX);

export function parseCustomId(id: NodeId): CustomIdParts | null {
  if (!isCustomId(id)) return null;
  const parts = id.slice(CUSTOM_PREFIX.length).split("/");
  if (parts.length !== 5) return null;
  const [group, version, kind, namespace, name] = parts;
  if (!version || !kind || !name) return null;
  return { group, version, kind, namespace: namespace === "" ? null : namespace, name };
}

/** Identity of a custom kind's table: tables, events and views compare by it. */
export const refKey = (r: Pick<ResourceRef, "group" | "version" | "kind">): string => `${r.group}/${r.version}/${r.kind}`;
