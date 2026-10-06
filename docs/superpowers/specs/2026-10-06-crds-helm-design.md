# Wiring — Custom resources and Helm releases

**Date:** 2026-10-06
**Status:** approved
**Builds on:** NetworkPolicies, RBAC and Nodes (branch `feat/graph-extras`).

## 1. Goal

Real clusters are full of CRDs and Helm charts. Make both first-class enough to work with: browse and edit any **custom resource** in a generic table, see where a CR sits in the wiring (what it owns), and see **Helm releases** — which chart and version, which revision, its values and the objects it installed.

## 2. Non-goals

Helm actions (install / upgrade / rollback / uninstall), editing values, rendering charts, CRD-specific UIs (cert-manager, Argo…), schema-aware YAML validation beyond the server's own, watching every custom resource kind all the time, Helm 2.

## 3. User flows

- **Custom resources in the navigator.** A **Custom Resources** section lists the API groups that have custom resource definitions the user can list (from discovery), each expandable to its kinds (`certificates.cert-manager.io → Certificate`). Counts appear once a kind has been opened. Cluster-scoped CR kinds are listed too.
- **Generic table.** Clicking a CR kind lists its objects in the current scope: **Name**, **Namespace** (multi-namespace scopes), the CRD's `additionalPrinterColumns` for the served version (JSONPath, as kubectl), **Age**. The list is watched while the table is open and stops when you leave it.
- **Details.** Overview (metadata, labels, `status.conditions` as rows, owner references), **YAML** with edit / diff / apply (same flow as built-in kinds, through the dynamic API), **Events**, delete, and **+ Create** from a minimal template (`apiVersion`, `kind`, `metadata`, `spec: {}`).
- **Graph.** Custom resources are not watched for the graph. When a built-in object has an `ownerReference` to a custom resource (e.g. a Certificate owning a Secret, a Rollout owning ReplicaSets), the graph shows the owner as a **CR node** (kind + name, neutral status) with an `owns` edge; selecting it loads its details on demand. A *Custom* kind chip toggles these nodes (on by default).
- **Helm releases.** A **Helm** section in the navigator lists releases in the scope (from Helm 3 storage Secrets `type: helm.sh/release.v1`; only the latest revision per release): **Name**, **Namespace**, **Chart** (`name-version`), **App version**, **Revision**, **Status** (`deployed` ok, `pending-*` warn, `failed` err), **Updated**. Selecting a release shows Overview (chart, versions, status, description, first-deployed/last-deployed), **Values** (the user-supplied values as read-only YAML), **History** (all stored revisions: number, chart version, status, updated, description), **Notes**, and **Resources** (the objects of the release that exist in the cluster, clickable). Selecting a release also highlights its objects on the graph.
- **Membership.** An object belongs to a release when it has `meta.helm.sh/release-name` (+ `-namespace`) annotations, or the `app.kubernetes.io/managed-by: Helm` label together with `app.kubernetes.io/instance: <release>`.
- **Secrets.** Helm storage Secrets stay out of the Secrets table and graph by default (a *Show Helm storage* toggle in the Secrets table reveals them), since they are noise there.

## 4. Backend

- **Discovery** (`src-tauri/src/discovery.rs`): on connect, `kube::discovery` of all groups; custom kinds = served resources not in the built-in set, keyed by `group/version/kind`, with plural, scope, verbs, preferred version; `additionalPrinterColumns` read from the CRD (`apiextensions.k8s.io/v1`) when the user can get CRDs, else just Name/Age. Exposed as `custom_kinds` (refreshed by `refresh_custom_kinds`).
- **Generic resources:** `ResourceRef { group, version, kind, plural, namespaced }` used by new commands `list_custom` (rows + starts a watch for the open table), `stop_custom`, and by the existing `get_object` / `update_object` / `delete_object` / `create_object` through a generalised node id `Custom/<group>/<version>/<kind>/<ns>/<name>` (cluster-scoped: no ns). JSONPath printer columns evaluated with a small subset (`.a.b`, `.a[0].b`, `.a[*].b`) that covers printer columns in practice; unsupported paths show `—`.
- **CR owners on the graph:** `graph::build` adds a CR node for each ownerReference whose kind isn't built-in, deduplicated, with an `owns` edge; node status `unknown`; details fetched with `get_object` on the generalised id.
- **Helm** (`src-tauri/src/helm.rs`): decode release Secrets (`data.release` → base64 → gzip → JSON; Helm double-encodes: base64(base64(gzip(json)))), keep latest revision per (namespace, name) for the list and all revisions for History; never log values. Commands `helm_releases` (list, in scope, from the cached Secrets) and `helm_release { namespace, name }` (overview, values YAML, history, notes, resource ids). Release membership computed from the store. `flate2` (MIT/Apache) is added for gzip.
- **Secrets table filter:** rows hide `type: helm.sh/release.v1` unless `list_rows` is asked with `includeHelmStorage: true`; the graph never shows them.

## 5. Frontend

- Navigator: *Custom Resources* (groups → kinds, lazily counted) and *Helm* (releases) sections.
- Generic table view for a `ResourceRef`; details panel works with generalised ids; Create template for CRs.
- Helm release view: list + details tabs (Overview, Values, History, Notes, Resources); selecting a release highlights member nodes (reusing the selection highlight with a set of ids).
- CR owner nodes (neutral style, a puzzle icon), *Custom* chip.
- Secrets table: *Show Helm storage* toggle.

## 6. Testing

- **Rust:** discovery classification (built-in vs custom, scope, plural), printer-column JSONPath subset, generalised id parsing/round-trip, CR owner nodes in the graph, Helm decoding on a real release Secret fixture (double base64 + gzip), latest-revision selection, history ordering, membership rules, status mapping, Secrets filter.
- **Smoke (docker-desktop only):** apply a small test CRD + one CR in the smoke namespace and a fake Helm release Secret (fixture generated from a real Helm 3 release) + one annotated ConfigMap; assert the CR kind is discovered, its table and YAML edit work, the release lists with chart/revision, its Resources include the ConfigMap. Clean up the CRD afterwards (it is cluster-scoped: name it `wiringsmoke.example.com` so nothing else can clash).
- **Vitest:** navigator sections, generic table, release view tabs, highlight of members, Show Helm storage toggle.

## 7. Decisions log

- CRs: discovery + generic table/details/edit, watched only while their table is open; on the graph only as owners of built-in objects.
- Helm: read-only, from Helm 3 storage Secrets; list, values, history, notes, resources, graph highlight.
- Helm storage Secrets hidden from the Secrets table and graph by default.
- The smoke test may create one uniquely named cluster-scoped test CRD and must delete it.
