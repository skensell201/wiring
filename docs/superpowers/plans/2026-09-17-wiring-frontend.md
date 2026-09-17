# Wiring Frontend (React) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React UI of Wiring on top of the finished Rust backend: context/namespace selection, the live relationship graph on a React Flow canvas with a stable kind-layered layout, kind filters and search, and the bottom details panel (Overview · YAML · Events) — styled after the n8n design system, tested with Vitest, shipped for macOS + Windows via GitHub Actions.

**Architecture:** The frontend is a renderer. A typed IPC layer (`src/shared/ipc`) mirrors the backend's JSON fixtures and wraps `invoke`/`listen`. One zustand store (`src/app/store.ts`) holds connection, graph (as maps), selection, filters and details; Tauri events reduce into it. A pure layout module turns the visible graph into positioned React Flow nodes (fixed layer per kind, barycenter ordering — deterministic and stable across deltas). Feature folders own their components: `features/cluster` (header pickers), `features/graph` (canvas, node/edge components, layout), `features/details` (bottom panel).

**Tech Stack:** React 19, TypeScript 6, Vite 8, Tailwind CSS 4 (`@tailwindcss/vite`), zustand 5, `@xyflow/react` 12, `shiki` 4 (JS regex engine, no wasm), `lucide-react`, `@fontsource-variable/inter`, `@tauri-apps/api` 2 + `plugin-store` + `plugin-dialog`, Vitest 5 + jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-17-wiring-mvp-design.md` §5.4, §6, §7, §9, §10. **IPC contract:** `docs/ipc-contract.md` + fixtures in `src/shared/ipc/fixtures/`. Backend branch `feat/backend` is the base.

**Deviation from spec §5.4 (decided here):** layout is a hand-written layered layout (fixed column per kind, barycenter ordering) instead of ELK in a web worker. Reasons: the layers are fixed by kind anyway, the result is deterministic and stable across deltas (ELK reshuffles), it is ~150 pure, unit-tested lines, and it avoids a worker + a 1.5 MB dependency. Update the spec in Task 11.

---

## File structure

```
wiring/
  package.json / vite.config.ts / tsconfig.json     tooling (Tailwind, Vitest)
  index.html                                       title "Wiring", dark background before React mounts
  src/
    main.tsx                                       mounts <App/>
    App.tsx                                        shell: Header / Canvas / DetailsPanel / Toasts / ContextPicker
    styles/theme.css                               Tailwind import + n8n design tokens (@theme) + base styles
    test/setup.ts                                  jest-dom matchers, ResizeObserver polyfill
    shared/ipc/types.ts                            TS mirrors of the Rust payload types
    shared/ipc/tauri.ts                            thin re-export of invoke/listen (mockable seam)
    shared/ipc/commands.ts                         typed invoke wrappers
    shared/ipc/events.ts                           typed listen wrappers → callbacks
    shared/ipc/fixtures/*.json                     (already exist — contract)
    shared/ipc/fixtures.test.ts                    runtime guard: fixtures parse into the TS types
    shared/settings.ts                             last context/namespace via plugin-store
    shared/ui/Toasts.tsx, Button.tsx, Chip.tsx, Dot.tsx   small primitives
    app/store.ts                                   zustand store + reducers (pure functions exported for tests)
    app/store.test.ts
    app/wireEvents.ts                              listen() → store actions; namespace-switch epoch guard
    app/wireEvents.test.ts
    app/startup.ts                                 boot sequence: contexts → last context → connect → last namespace
    features/graph/layout.ts                       kind → layer, barycenter ordering, positions
    features/graph/layout.test.ts
    features/graph/toFlow.ts                       store graph → React Flow nodes/edges (filters, search, hover)
    features/graph/toFlow.test.ts
    features/graph/ResourceNode.tsx                node card (icon, kind, name, badges, status dot)
    features/graph/ResourceNode.test.tsx
    features/graph/RelationEdge.tsx                gradient bezier edge
    features/graph/KindChips.tsx                   filter chips (with "no access" marker)
    features/graph/Canvas.tsx                      <ReactFlow> wiring, minimap, controls, empty states
    features/cluster/Header.tsx                    logo, context ▾, namespace ▾, search, connection dot, Reconnect
    features/cluster/ContextPicker.tsx             modal/empty state listing contexts + "Add kubeconfig…"
    features/cluster/NamespacePicker.tsx           dropdown + free-text fallback
    features/details/DetailsPanel.tsx              resizable bottom panel + tabs
    features/details/OverviewTab.tsx / YamlTab.tsx / EventsTab.tsx
    features/details/DetailsPanel.test.tsx
    features/details/yaml.ts                       shiki highlighter (lazy, JS engine)
  .github/workflows/ci.yml                         cargo + pnpm checks
  .github/workflows/release.yml                    tauri-action matrix on tags
```

---

### Task 0: Tooling — Tailwind 4, Vitest, theme tokens, fonts, CSP

**Files:**
- Modify: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src-tauri/tauri.conf.json`
- Create: `src/styles/theme.css`, `src/test/setup.ts`, `src/App.tsx` (placeholder), `src/app/smoke.test.tsx`
- Delete: `src/App.css`, `src/assets/*` (template leftovers)

- [ ] **Step 1: Install dependencies**

Run (repo root):
```bash
cd /Users/skensel/WORKING/AI/wiring
pnpm remove @tauri-apps/plugin-opener
pnpm add @xyflow/react@^12.11 zustand@^5 shiki@^4 lucide-react@^1 @fontsource-variable/inter@^5 @tauri-apps/plugin-store@^2 @tauri-apps/plugin-dialog@^2
pnpm add -D tailwindcss@^4 @tailwindcss/vite@^4 vitest@^5 jsdom@^30 @testing-library/react@^16 @testing-library/jest-dom@^7 @testing-library/user-event@^14 @types/node
```
Expected: lockfile updated, no peer warnings that mention React 19 incompatibility.

- [ ] **Step 2: Scripts and Vite/Vitest config**

`package.json` scripts:
```json
"scripts": {
  "dev": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit",
  "tauri": "tauri"
}
```

`vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
```

`tsconfig.json` needs no changes: tests import `describe/it/expect` from `vitest` explicitly, and `src/test/setup.ts` (inside `include: ["src"]`) pulls in the jest-dom matcher types. All imports in this plan are relative — no path aliases.

- [ ] **Step 3: Theme tokens** `src/styles/theme.css`

```css
@import "tailwindcss";
@import "@fontsource-variable/inter";

@theme {
  --color-void: #0e0918;
  --color-surface: #1a1624;
  --color-panel: #1b1728;
  --color-muted: #2c2834;
  --color-border: #3e3a46;
  --color-text: #d1cece;
  --color-text-muted: #9d9797;
  --color-text-hi: #ffffff;
  --color-ember-a: #fd8925;
  --color-ember-b: #ff0c00;
  --color-current-a: #077ac7;
  --color-current-b: #6b21ef;
  --color-status-ok: #2ecc71;
  --color-status-warn: #fd8925;
  --color-status-err: #ff0c00;
  --color-status-unknown: #9d9797;
  --font-sans: "Inter Variable", Inter, system-ui, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --radius-node: 12px;
  --radius-card: 16px;
}

:root { color-scheme: dark; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--color-void);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
  user-select: none;
}
.gradient-ember { background-image: linear-gradient(30deg, var(--color-ember-a), var(--color-ember-b)); }
.gradient-current { background-image: linear-gradient(141deg, var(--color-current-a), var(--color-current-b)); }
.drag-region { -webkit-app-region: drag; }
.no-drag { -webkit-app-region: no-drag; }
.selectable { user-select: text; }
```

- [ ] **Step 4: Entry files**

`index.html` (replace `<title>` and body background):
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Wiring</title>
    <style>html,body{background:#0e0918}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles/theme.css";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

`src/App.tsx` (placeholder, replaced in Task 8):
```tsx
export function App() {
  return <div className="h-full grid place-items-center text-text-muted">Wiring</div>;
}
```

`src/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";

// React Flow measures nodes with ResizeObserver; jsdom has none.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
```

Delete `src/App.css` and the `src/assets` folder. Remove the template's `greet` code (it lived in the old `App.tsx`).

- [ ] **Step 5: CSP**

In `src-tauri/tauri.conf.json` replace `"security": { "csp": null }` with:
```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ipc: http://ipc.localhost"
}
```
(`style-src 'unsafe-inline'` is needed by React Flow's inline transforms; `connect-src ipc:` is Tauri 2's IPC scheme.)

- [ ] **Step 6: Smoke test** `src/app/smoke.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App";

describe("App shell", () => {
  it("renders", () => {
    render(<App />);
    expect(screen.getByText("Wiring")).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Verify**

Run: `cd /Users/skensel/WORKING/AI/wiring && pnpm typecheck && pnpm test && pnpm build 2>&1 | tail -3`
Expected: typecheck clean; `1 passed`; Vite build succeeds. Then `cd src-tauri && cargo build 2>&1 | tail -1` still `Finished` (CSP change re-validates config).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "Set up Tailwind, Vitest, design tokens and CSP for the frontend"
```

---

### Task 1: Typed IPC layer

**Files:**
- Create: `src/shared/ipc/types.ts`, `src/shared/ipc/tauri.ts`, `src/shared/ipc/commands.ts`, `src/shared/ipc/events.ts`, `src/shared/ipc/fixtures.test.ts`

- [ ] **Step 1: Write the failing fixture-guard test** `src/shared/ipc/fixtures.test.ts`

```ts
import { describe, expect, it } from "vitest";
import appError from "./fixtures/app_error.json";
import connectInfo from "./fixtures/connect_info.json";
import connectionState from "./fixtures/connection_state.json";
import contextInfo from "./fixtures/context_info.json";
import graph from "./fixtures/graph.json";
import graphDelta from "./fixtures/graph_delta.json";
import objectDetails from "./fixtures/object_details.json";
import objectEvents from "./fixtures/object_events.json";
import {
  CONNECTION_STATES, ERROR_KINDS, KINDS, RELATIONS, STATUSES,
  isAppError, isConnectInfo, isConnectionState, isContextInfo, isGraph, isGraphDelta, isObjectDetails, isObjectEvents,
} from "./types";

// The JSON files are the contract shared with the Rust side (guarded there by
// src-tauri/tests/ipc_fixtures.rs). These guards make sure the TS mirrors keep up.
describe("IPC fixtures match the TypeScript types", () => {
  it("context_info", () => expect(isContextInfo(contextInfo)).toBe(true));
  it("connect_info", () => expect(isConnectInfo(connectInfo)).toBe(true));
  it("graph", () => expect(isGraph(graph)).toBe(true));
  it("graph_delta", () => expect(isGraphDelta(graphDelta)).toBe(true));
  it("object_details", () => expect(isObjectDetails(objectDetails)).toBe(true));
  it("object_events", () => expect(isObjectEvents(objectEvents)).toBe(true));
  it("connection_state", () => expect(isConnectionState(connectionState)).toBe(true));
  it("app_error", () => expect(isAppError(appError)).toBe(true));

  it("enum lists match docs/ipc-contract.md", () => {
    expect(KINDS).toHaveLength(16);
    expect(KINDS).toContain("PodGroup");
    expect(STATUSES).toEqual(["ok", "warn", "err", "unknown"]);
    expect(RELATIONS).toEqual(["owns", "selects", "routes", "mounts", "envFrom", "claims", "binds", "usesSA", "scales"]);
    expect(ERROR_KINDS).toEqual(["auth", "network", "forbidden", "notFound", "internal"]);
    expect(CONNECTION_STATES).toEqual(["connected", "degraded", "disconnected"]);
  });

  it("rejects a node with an unknown status", () => {
    const bad = { ...graph, nodes: [{ ...graph.nodes[0], status: "green" }] };
    expect(isGraph(bad)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/shared/ipc` → fails: `./types` has no exports.

- [ ] **Step 3: Implement** `src/shared/ipc/types.ts`

```ts
// Mirrors of the Rust payload types. Keep in sync with src/shared/ipc/fixtures/*.json
// and docs/ipc-contract.md. Runtime guards are deliberately shallow: they check
// shapes and enum values, not every optional field.

export const KINDS = [
  "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod", "Service", "Ingress",
  "ConfigMap", "Secret", "PersistentVolumeClaim", "PersistentVolume", "ServiceAccount", "HorizontalPodAutoscaler",
  "PodGroup",
] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = ["ok", "warn", "err", "unknown"] as const;
export type Status = (typeof STATUSES)[number];

export const RELATIONS = ["owns", "selects", "routes", "mounts", "envFrom", "claims", "binds", "usesSA", "scales"] as const;
export type Relation = (typeof RELATIONS)[number];

export const ERROR_KINDS = ["auth", "network", "forbidden", "notFound", "internal"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export const CONNECTION_STATES = ["connected", "degraded", "disconnected"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type NodeId = string;

export interface GroupInfo { count: number; ok: number; warn: number; err: number }

export interface GraphNode {
  id: NodeId;
  kind: Kind;
  namespace: string | null;
  name: string;
  status: Status;
  badges: string[];
  group: GroupInfo | null;
}

export interface GraphEdge { id: string; source: NodeId; target: NodeId; relation: Relation }

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface GraphDelta {
  addedNodes: GraphNode[];
  updatedNodes: GraphNode[];
  removedNodes: NodeId[];
  addedEdges: GraphEdge[];
  removedEdges: string[];
}

export interface ContextInfo { name: string; cluster: string; user: string; namespace: string | null; sourceFile: string }
export interface ConnectInfo { context: string; serverVersion: string; namespaces: string[] }
export interface ObjectDetails { yaml: string; summary: [string, string][]; related: NodeId[] }
export interface K8sEvent {
  name: string; type: string; reason: string; message: string; count: number;
  firstTimestamp: string | null; lastTimestamp: string | null;
}
export interface ObjectEvents { nodeId: NodeId; events: K8sEvent[] }
export interface AppError { kind: ErrorKind; message: string }

// ---- guards ---------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => isStr(v) && (list as readonly string[]).includes(v);
const arrayOf = <T>(v: unknown, g: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(g);

export function isGraphNode(v: unknown): v is GraphNode {
  return isObj(v) && isStr(v.id) && oneOf(KINDS, v.kind) && isStrOrNull(v.namespace) && isStr(v.name)
    && oneOf(STATUSES, v.status) && arrayOf(v.badges, isStr) && (v.group === null || (isObj(v.group) && typeof v.group.count === "number"));
}
export function isGraphEdge(v: unknown): v is GraphEdge {
  return isObj(v) && isStr(v.id) && isStr(v.source) && isStr(v.target) && oneOf(RELATIONS, v.relation);
}
export function isGraph(v: unknown): v is Graph {
  return isObj(v) && arrayOf(v.nodes, isGraphNode) && arrayOf(v.edges, isGraphEdge);
}
export function isGraphDelta(v: unknown): v is GraphDelta {
  return isObj(v) && arrayOf(v.addedNodes, isGraphNode) && arrayOf(v.updatedNodes, isGraphNode)
    && arrayOf(v.removedNodes, isStr) && arrayOf(v.addedEdges, isGraphEdge) && arrayOf(v.removedEdges, isStr);
}
export function isContextInfo(v: unknown): v is ContextInfo {
  return isObj(v) && isStr(v.name) && isStr(v.cluster) && isStr(v.user) && isStrOrNull(v.namespace) && isStr(v.sourceFile);
}
export function isConnectInfo(v: unknown): v is ConnectInfo {
  return isObj(v) && isStr(v.context) && isStr(v.serverVersion) && arrayOf(v.namespaces, isStr);
}
export function isObjectDetails(v: unknown): v is ObjectDetails {
  return isObj(v) && isStr(v.yaml) && Array.isArray(v.summary)
    && v.summary.every((r) => Array.isArray(r) && r.length === 2 && isStr(r[0]) && isStr(r[1])) && arrayOf(v.related, isStr);
}
export function isK8sEvent(v: unknown): v is K8sEvent {
  return isObj(v) && isStr(v.name) && isStr(v.type) && isStr(v.reason) && isStr(v.message) && typeof v.count === "number"
    && isStrOrNull(v.firstTimestamp) && isStrOrNull(v.lastTimestamp);
}
export function isObjectEvents(v: unknown): v is ObjectEvents {
  return isObj(v) && isStr(v.nodeId) && arrayOf(v.events, isK8sEvent);
}
export function isConnectionState(v: unknown): v is ConnectionState { return oneOf(CONNECTION_STATES, v); }
export function isAppError(v: unknown): v is AppError { return isObj(v) && oneOf(ERROR_KINDS, v.kind) && isStr(v.message); }

export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof Error) return { kind: "internal", message: e.message };
  return { kind: "internal", message: String(e) };
}
```

`src/shared/ipc/tauri.ts` (the only file importing `@tauri-apps/api` core — tests mock this module):
```ts
export { invoke } from "@tauri-apps/api/core";
export { listen } from "@tauri-apps/api/event";
export type { UnlistenFn } from "@tauri-apps/api/event";
```

`src/shared/ipc/commands.ts`:
```ts
import { invoke } from "./tauri";
import type { ConnectInfo, ContextInfo, Kind, NodeId, ObjectDetails } from "./types";
import { toAppError } from "./types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const commands = {
  listContexts: () => call<ContextInfo[]>("list_contexts"),
  addKubeconfig: (path: string) => call<ContextInfo[]>("add_kubeconfig", { path }),
  connect: (context: string) => call<ConnectInfo>("connect", { context }),
  disconnect: () => call<null>("disconnect"),
  selectNamespace: (namespace: string, expandedGroups: NodeId[]) => call<null>("select_namespace", { namespace, expandedGroups }),
  setExpandedGroups: (expandedGroups: NodeId[]) => call<null>("set_expanded_groups", { expandedGroups }),
  getObject: (nodeId: NodeId) => call<ObjectDetails>("get_object", { nodeId }),
  watchEvents: (nodeId: NodeId | null) => call<null>("watch_events", { nodeId }),
  deniedKinds: () => call<Kind[]>("denied_kinds"),
};
```

`src/shared/ipc/events.ts`:
```ts
import { listen, type UnlistenFn } from "./tauri";
import type { AppError, ConnectionState, Graph, GraphDelta, ObjectEvents } from "./types";

export interface BackendEvents {
  graph_snapshot: Graph;
  graph_delta: GraphDelta;
  object_events: ObjectEvents;
  connection_state: ConnectionState;
  connection_error: AppError;
}

export type EventHandlers = { [K in keyof BackendEvents]: (payload: BackendEvents[K]) => void };

/** Subscribe to every backend event; returns a function that unsubscribes all. */
export async function listenAll(handlers: EventHandlers): Promise<() => void> {
  const unlisteners: UnlistenFn[] = [];
  for (const name of Object.keys(handlers) as (keyof BackendEvents)[]) {
    unlisteners.push(await listen(name, (e) => handlers[name](e.payload as never)));
  }
  return () => unlisteners.forEach((u) => u());
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/shared/ipc` → `10 passed`. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add typed IPC layer mirroring the backend contract"
```

---

### Task 2: Application store (zustand)

**Files:**
- Create: `src/app/store.ts`, `src/app/store.test.ts`

The store is the single source of truth. Graph reducers are exported as pure functions so they are trivially testable; async actions go through `commands` (tests mock `shared/ipc/tauri`).

- [ ] **Step 1: Write the failing tests** `src/app/store.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import graphFixture from "../shared/ipc/fixtures/graph.json";
import type { Graph, GraphDelta, GraphNode } from "../shared/ipc/types";

vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_object") return { yaml: "kind: Pod\n", summary: [["Name", "web-1"]], related: [] };
    if (cmd === "denied_kinds") return ["Secret"];
    if (cmd === "connect") return { context: "prod", serverVersion: "v1.33.0", namespaces: ["default", "payments"] };
    return null;
  }),
  listen: vi.fn(async () => () => {}),
}));

import { invoke } from "../shared/ipc/tauri";
import { applyDelta, applySnapshot, initialState, useAppStore } from "./store";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: "Pod", namespace: "p", name: id.split("/").pop()!, status: "ok", badges: ["Running"], group: null, ...over,
});

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockClear();
});

describe("graph reducers", () => {
  it("snapshot replaces everything and marks the graph ready", () => {
    const s = applySnapshot(initialState(), graphFixture as Graph);
    expect(s.nodes.size).toBe(2);
    expect(s.edges.size).toBe(1);
    expect(s.graphReady).toBe(true);
  });

  it("delta adds, updates and removes; selection survives when its node stays", () => {
    let s = applySnapshot(initialState(), { nodes: [node("Pod/p/a"), node("Pod/p/b")], edges: [] });
    s = { ...s, selectedId: "Pod/p/a" };
    const delta: GraphDelta = {
      addedNodes: [node("Pod/p/c")],
      updatedNodes: [node("Pod/p/a", { status: "err", badges: ["CrashLoopBackOff"] })],
      removedNodes: ["Pod/p/b"],
      addedEdges: [{ id: "Pod/p/a->Pod/p/c:owns", source: "Pod/p/a", target: "Pod/p/c", relation: "owns" }],
      removedEdges: [],
    };
    s = applyDelta(s, delta);
    expect([...s.nodes.keys()].sort()).toEqual(["Pod/p/a", "Pod/p/c"]);
    expect(s.nodes.get("Pod/p/a")?.status).toBe("err");
    expect(s.edges.size).toBe(1);
    expect(s.selectedId).toBe("Pod/p/a");
  });

  it("delta removing the selected node clears selection and details", () => {
    let s = applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] });
    s = { ...s, selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data: null, events: [], loading: false } };
    s = applyDelta(s, { addedNodes: [], updatedNodes: [], removedNodes: ["Pod/p/a"], addedEdges: [], removedEdges: [] });
    expect(s.selectedId).toBeNull();
    expect(s.details).toBeNull();
  });

  it("deltas are ignored until a snapshot arrived", () => {
    const s = applyDelta(initialState(), { addedNodes: [node("Pod/p/a")], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });
    expect(s.nodes.size).toBe(0);
  });
});

describe("actions", () => {
  it("select loads details and starts the events watcher; deselect stops it", async () => {
    useAppStore.setState(applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }));
    await useAppStore.getState().select("Pod/p/a");
    expect(useAppStore.getState().details?.data?.yaml).toBe("kind: Pod\n");
    expect(invoke).toHaveBeenCalledWith("get_object", { nodeId: "Pod/p/a" });
    expect(invoke).toHaveBeenCalledWith("watch_events", { nodeId: "Pod/p/a" });
    await useAppStore.getState().select(null);
    expect(invoke).toHaveBeenCalledWith("watch_events", { nodeId: null });
    expect(useAppStore.getState().details).toBeNull();
  });

  it("selectNamespace clears the graph, resets readiness and asks the backend", async () => {
    useAppStore.setState({ ...applySnapshot(initialState(), { nodes: [node("Pod/p/a")], edges: [] }), connection: { ...initialState().connection, context: "prod" } });
    await useAppStore.getState().selectNamespace("payments");
    const s = useAppStore.getState();
    expect(s.nodes.size).toBe(0);
    expect(s.graphReady).toBe(false);
    expect(s.connection.namespace).toBe("payments");
    expect(invoke).toHaveBeenCalledWith("select_namespace", { namespace: "payments", expandedGroups: [] });
  });

  it("toggleGroup updates expandedGroups and pushes them to the backend", async () => {
    await useAppStore.getState().toggleGroup("PodGroup/p/Deployment/web");
    expect([...useAppStore.getState().expandedGroups]).toEqual(["PodGroup/p/Deployment/web"]);
    expect(invoke).toHaveBeenCalledWith("set_expanded_groups", { expandedGroups: ["PodGroup/p/Deployment/web"] });
    await useAppStore.getState().toggleGroup("PodGroup/p/Deployment/web");
    expect(useAppStore.getState().expandedGroups.size).toBe(0);
  });

  it("connect stores connection info and refreshes denied kinds after a namespace is chosen", async () => {
    await useAppStore.getState().connect("prod");
    const c = useAppStore.getState().connection;
    expect(c.context).toBe("prod");
    expect(c.serverVersion).toBe("v1.33.0");
    expect(c.namespaces).toEqual(["default", "payments"]);
    expect(c.state).toBe("connected");
  });

  it("connect failure becomes a toast and leaves the connection untouched", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "auth", message: "exec plugin missing" });
    await useAppStore.getState().connect("prod");
    expect(useAppStore.getState().connection.context).toBeNull();
    expect(useAppStore.getState().toasts[0]).toMatchObject({ kind: "auth", message: "exec plugin missing" });
  });

  it("toggleKind hides and shows kinds; setSearch stores the query", () => {
    useAppStore.getState().toggleKind("Secret");
    expect(useAppStore.getState().hiddenKinds.has("Secret")).toBe(true);
    useAppStore.getState().toggleKind("Secret");
    expect(useAppStore.getState().hiddenKinds.has("Secret")).toBe(false);
    useAppStore.getState().setSearch("web");
    expect(useAppStore.getState().search).toBe("web");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/app/store` → fails: cannot find `./store`.

- [ ] **Step 3: Implement** `src/app/store.ts`

```ts
import { create } from "zustand";
import { commands } from "../shared/ipc/commands";
import type {
  AppError, ConnectionState, ContextInfo, Graph, GraphDelta, GraphEdge, GraphNode, K8sEvent, Kind, NodeId, ObjectDetails,
} from "../shared/ipc/types";
import { toAppError } from "../shared/ipc/types";

export interface Toast { id: number; kind: AppError["kind"] | "info"; message: string }

export interface Details { nodeId: NodeId; data: ObjectDetails | null; events: K8sEvent[]; loading: boolean }

export interface Connection {
  state: ConnectionState;
  context: string | null;
  serverVersion: string | null;
  namespaces: string[];
  namespace: string | null;
  busy: boolean;
}

export interface GraphState {
  nodes: Map<NodeId, GraphNode>;
  edges: Map<string, GraphEdge>;
  /** false between select_namespace and the next graph_snapshot — deltas are ignored meanwhile. */
  graphReady: boolean;
  selectedId: NodeId | null;
  details: Details | null;
}

export interface AppState extends GraphState {
  contexts: ContextInfo[];
  connection: Connection;
  hoveredId: NodeId | null;
  expandedGroups: Set<NodeId>;
  hiddenKinds: Set<Kind>;
  deniedKinds: Set<Kind>;
  search: string;
  toasts: Toast[];
  pickerOpen: boolean;

  // graph events
  applySnapshot: (g: Graph) => void;
  applyDelta: (d: GraphDelta) => void;
  setObjectEvents: (nodeId: NodeId, events: K8sEvent[]) => void;
  setConnectionState: (s: ConnectionState) => void;
  // user actions
  loadContexts: () => Promise<void>;
  addKubeconfig: (path: string) => Promise<void>;
  connect: (context: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  selectNamespace: (namespace: string) => Promise<void>;
  select: (id: NodeId | null) => Promise<void>;
  setHovered: (id: NodeId | null) => void;
  toggleGroup: (id: NodeId) => Promise<void>;
  toggleKind: (kind: Kind) => void;
  setSearch: (q: string) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  setPickerOpen: (open: boolean) => void;
}

let toastSeq = 0;

export function initialState(): Omit<AppState, keyof Actions> {
  return {
    contexts: [],
    connection: { state: "disconnected", context: null, serverVersion: null, namespaces: [], namespace: null, busy: false },
    nodes: new Map(),
    edges: new Map(),
    graphReady: false,
    selectedId: null,
    details: null,
    hoveredId: null,
    expandedGroups: new Set(),
    hiddenKinds: new Set(),
    deniedKinds: new Set(),
    search: "",
    toasts: [],
    pickerOpen: false,
  };
}

type Actions = Pick<AppState,
  | "applySnapshot" | "applyDelta" | "setObjectEvents" | "setConnectionState" | "loadContexts" | "addKubeconfig" | "connect"
  | "disconnect" | "selectNamespace" | "select" | "setHovered" | "toggleGroup" | "toggleKind" | "setSearch" | "toast"
  | "dismissToast" | "setPickerOpen">;

// ---- pure reducers --------------------------------------------------------

export function applySnapshot<S extends GraphState>(s: S, g: Graph): S {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const edges = new Map(g.edges.map((e) => [e.id, e]));
  return keepSelection({ ...s, nodes, edges, graphReady: true });
}

export function applyDelta<S extends GraphState>(s: S, d: GraphDelta): S {
  if (!s.graphReady) return s;
  const nodes = new Map(s.nodes);
  const edges = new Map(s.edges);
  for (const id of d.removedNodes) nodes.delete(id);
  for (const n of d.addedNodes) nodes.set(n.id, n);
  for (const n of d.updatedNodes) nodes.set(n.id, n);
  for (const id of d.removedEdges) edges.delete(id);
  for (const e of d.addedEdges) edges.set(e.id, e);
  return keepSelection({ ...s, nodes, edges });
}

function keepSelection<S extends GraphState>(s: S): S {
  if (s.selectedId && !s.nodes.has(s.selectedId)) return { ...s, selectedId: null, details: null };
  return s;
}

// ---- store ----------------------------------------------------------------

export const useAppStore = create<AppState>()((set, get) => ({
  ...initialState(),

  applySnapshot: (g) => set((s) => applySnapshot(s, g)),
  applyDelta: (d) => set((s) => applyDelta(s, d)),
  setObjectEvents: (nodeId, events) =>
    set((s) => (s.details && s.details.nodeId === nodeId ? { details: { ...s.details, events } } : {})),
  setConnectionState: (state) => set((s) => ({ connection: { ...s.connection, state } })),

  loadContexts: async () => {
    try {
      set({ contexts: await commands.listContexts() });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  addKubeconfig: async (path) => {
    try {
      set({ contexts: await commands.addKubeconfig(path) });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  connect: async (context) => {
    set((s) => ({ connection: { ...s.connection, busy: true } }));
    try {
      const info = await commands.connect(context);
      set({
        ...initialState(),
        contexts: get().contexts,
        hiddenKinds: get().hiddenKinds,
        connection: { state: "connected", context: info.context, serverVersion: info.serverVersion, namespaces: info.namespaces, namespace: null, busy: false },
      });
      return true;
    } catch (e) {
      set((s) => ({ connection: { ...s.connection, busy: false } }));
      get().toast(toAppError(e));
      return false;
    }
  },

  disconnect: async () => {
    try {
      await commands.disconnect();
    } finally {
      set({ ...initialState(), contexts: get().contexts, hiddenKinds: get().hiddenKinds, pickerOpen: true });
    }
  },

  selectNamespace: async (namespace) => {
    const expanded = [...get().expandedGroups];
    set((s) => ({
      nodes: new Map(), edges: new Map(), graphReady: false, selectedId: null, details: null, hoveredId: null,
      deniedKinds: new Set(), connection: { ...s.connection, namespace },
    }));
    try {
      await commands.selectNamespace(namespace, expanded);
      set({ deniedKinds: new Set(await commands.deniedKinds()) });
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  select: async (id) => {
    if (id === null) {
      set({ selectedId: null, details: null });
      await commands.watchEvents(null).catch(() => {});
      return;
    }
    set({ selectedId: id, details: { nodeId: id, data: null, events: [], loading: true } });
    try {
      const [data] = await Promise.all([commands.getObject(id), commands.watchEvents(id)]);
      set((s) => (s.selectedId === id ? { details: { nodeId: id, data, events: s.details?.events ?? [], loading: false } } : {}));
    } catch (e) {
      set((s) => (s.selectedId === id ? { details: { nodeId: id, data: null, events: [], loading: false } } : {}));
      get().toast(toAppError(e));
    }
  },

  setHovered: (id) => set({ hoveredId: id }),

  toggleGroup: async (id) => {
    const next = new Set(get().expandedGroups);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ expandedGroups: next });
    try {
      await commands.setExpandedGroups([...next]);
    } catch (e) {
      get().toast(toAppError(e));
    }
  },

  toggleKind: (kind) =>
    set((s) => {
      const next = new Set(s.hiddenKinds);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return { hiddenKinds: next };
    }),

  setSearch: (search) => set({ search }),

  toast: (t) => set((s) => ({ toasts: [...s.toasts, { id: ++toastSeq, ...t }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setPickerOpen: (pickerOpen) => set({ pickerOpen }),
}));
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/app/store` → `9 passed`; `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add application store with graph reducers and IPC-backed actions"
```

---

### Task 3: Layered layout

**Files:**
- Create: `src/features/graph/layout.ts`, `src/features/graph/layout.test.ts`

Layers (left → right) from spec §5.4: `0 HPA · 1 Ingress · 2 Service · 3 Deployment/StatefulSet/DaemonSet/CronJob · 4 ReplicaSet/Job · 5 ConfigMap/Secret/PVC/PV/ServiceAccount · 6 Pod/PodGroup`. Nodes are 220×64 px; column gap 96; row gap 24. Ordering inside a layer: two barycenter sweeps (left→right using predecessors, then right→left using successors), ties broken by id; nodes with no visible neighbour go to the bottom of their column. Empty layers collapse (no empty columns).

- [ ] **Step 1: Write the failing tests** `src/features/graph/layout.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, Kind } from "../../shared/ipc/types";
import { COLUMN_GAP, NODE_HEIGHT, NODE_WIDTH, ROW_GAP, layerOf, layout } from "./layout";

const n = (id: string, kind: Kind): GraphNode => ({ id, kind, namespace: "p", name: id.split("/").pop()!, status: "ok", badges: [], group: null });
const e = (source: string, target: string): GraphEdge => ({ id: `${source}->${target}:owns`, source, target, relation: "owns" });

describe("layerOf", () => {
  it("maps every kind to its spec column", () => {
    expect(layerOf("HorizontalPodAutoscaler")).toBe(0);
    expect(layerOf("Ingress")).toBe(1);
    expect(layerOf("Service")).toBe(2);
    expect(layerOf("Deployment")).toBe(3);
    expect(layerOf("CronJob")).toBe(3);
    expect(layerOf("ReplicaSet")).toBe(4);
    expect(layerOf("Job")).toBe(4);
    expect(layerOf("ConfigMap")).toBe(5);
    expect(layerOf("PersistentVolume")).toBe(5);
    expect(layerOf("Pod")).toBe(6);
    expect(layerOf("PodGroup")).toBe(6);
  });
});

describe("layout", () => {
  it("places kinds in columns and collapses empty layers", () => {
    const nodes = [n("Service/p/s", "Service"), n("Deployment/p/d", "Deployment"), n("Pod/p/a", "Pod")];
    const pos = layout(nodes, [e("Service/p/s", "Pod/p/a"), e("Deployment/p/d", "Pod/p/a")]);
    expect(pos.get("Service/p/s")!.x).toBe(0);
    expect(pos.get("Deployment/p/d")!.x).toBe(NODE_WIDTH + COLUMN_GAP);
    expect(pos.get("Pod/p/a")!.x).toBe(2 * (NODE_WIDTH + COLUMN_GAP));
  });

  it("stacks nodes in a column with the row gap", () => {
    const nodes = [n("Pod/p/a", "Pod"), n("Pod/p/b", "Pod")];
    const pos = layout(nodes, []);
    const ys = [pos.get("Pod/p/a")!.y, pos.get("Pod/p/b")!.y].sort((a, b) => a - b);
    expect(ys).toEqual([0, NODE_HEIGHT + ROW_GAP]);
  });

  it("orders a column by the position of its predecessors (barycenter)", () => {
    // Two deployments; the pods of the *second* deployment must sit below the first's pods.
    const nodes = [
      n("Deployment/p/a", "Deployment"), n("Deployment/p/b", "Deployment"),
      n("Pod/p/b1", "Pod"), n("Pod/p/a1", "Pod"), n("Pod/p/b2", "Pod"), n("Pod/p/a2", "Pod"),
    ];
    const edges = [e("Deployment/p/a", "Pod/p/a1"), e("Deployment/p/a", "Pod/p/a2"), e("Deployment/p/b", "Pod/p/b1"), e("Deployment/p/b", "Pod/p/b2")];
    const pos = layout(nodes, edges);
    const y = (id: string) => pos.get(id)!.y;
    expect(Math.max(y("Pod/p/a1"), y("Pod/p/a2"))).toBeLessThan(Math.min(y("Pod/p/b1"), y("Pod/p/b2")));
  });

  it("is deterministic regardless of input order and puts orphans last", () => {
    const nodes = [n("Pod/p/z", "Pod"), n("Pod/p/a", "Pod"), n("Deployment/p/d", "Deployment")];
    const edges = [e("Deployment/p/d", "Pod/p/z")];
    const a = layout(nodes, edges);
    const b = layout([...nodes].reverse(), [...edges]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get("Pod/p/z")!.y).toBeLessThan(a.get("Pod/p/a")!.y); // connected first, orphan last
  });

  it("ignores edges whose endpoints are not laid out", () => {
    const pos = layout([n("Pod/p/a", "Pod")], [e("Deployment/p/gone", "Pod/p/a")]);
    expect(pos.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/features/graph/layout` → fails: cannot find `./layout`.

- [ ] **Step 3: Implement** `src/features/graph/layout.ts`

```ts
import type { GraphEdge, GraphNode, Kind, NodeId } from "../../shared/ipc/types";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 64;
export const COLUMN_GAP = 96;
export const ROW_GAP = 24;

export interface Position { x: number; y: number }

const LAYERS: Record<Kind, number> = {
  HorizontalPodAutoscaler: 0,
  Ingress: 1,
  Service: 2,
  Deployment: 3, StatefulSet: 3, DaemonSet: 3, CronJob: 3,
  ReplicaSet: 4, Job: 4,
  ConfigMap: 5, Secret: 5, PersistentVolumeClaim: 5, PersistentVolume: 5, ServiceAccount: 5,
  Pod: 6, PodGroup: 6,
};

export function layerOf(kind: Kind): number {
  return LAYERS[kind];
}

/**
 * Deterministic layered layout: one column per (non-empty) layer, rows ordered by
 * the barycenter of already-placed neighbours, ties broken by id, orphans last.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[]): Map<NodeId, Position> {
  const ids = new Set(nodes.map((n) => n.id));
  const preds = new Map<NodeId, NodeId[]>();
  const succs = new Map<NodeId, NodeId[]>();
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    (preds.get(e.target) ?? preds.set(e.target, []).get(e.target)!).push(e.source);
    (succs.get(e.source) ?? succs.set(e.source, []).get(e.source)!).push(e.target);
  }

  // Group by layer, drop empty layers.
  const byLayer = new Map<number, GraphNode[]>();
  for (const n of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const l = layerOf(n.kind);
    (byLayer.get(l) ?? byLayer.set(l, []).get(l)!).push(n);
  }
  const columns = [...byLayer.keys()].sort((a, b) => a - b).map((l) => byLayer.get(l)!.map((n) => n.id));

  const rowOf = new Map<NodeId, number>();
  const assignRows = (col: NodeId[]) => col.forEach((id, i) => rowOf.set(id, i));
  columns.forEach(assignRows);

  const order = (col: NodeId[], neighbours: Map<NodeId, NodeId[]>) => {
    const key = (id: NodeId): number | null => {
      const ns = (neighbours.get(id) ?? []).map((n) => rowOf.get(n)).filter((r): r is number => r !== undefined);
      return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
    };
    const keyed = col.map((id) => ({ id, k: key(id) }));
    keyed.sort((a, b) => {
      if (a.k === null && b.k === null) return a.id.localeCompare(b.id);
      if (a.k === null) return 1;
      if (b.k === null) return -1;
      return a.k - b.k || a.id.localeCompare(b.id);
    });
    const sorted = keyed.map((k) => k.id);
    assignRows(sorted);
    return sorted;
  };

  // Sweep left→right on predecessors, then right→left on successors.
  for (let i = 1; i < columns.length; i++) columns[i] = order(columns[i], preds);
  for (let i = columns.length - 2; i >= 0; i--) columns[i] = order(columns[i], succs);

  const positions = new Map<NodeId, Position>();
  columns.forEach((col, c) => {
    col.forEach((id, r) => positions.set(id, { x: c * (NODE_WIDTH + COLUMN_GAP), y: r * (NODE_HEIGHT + ROW_GAP) }));
  });
  return positions;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/features/graph/layout` → `6 passed`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add deterministic kind-layered graph layout"
```

---

### Task 4: Store graph → React Flow nodes/edges

**Files:**
- Create: `src/features/graph/toFlow.ts`, `src/features/graph/toFlow.test.ts`

Applies kind filters (hidden kinds and their edges are dropped before layout so the rest tightens), search (matching nodes highlighted, others dimmed), hover (edges touching the hovered node highlighted, others dimmed), selection.

- [ ] **Step 1: Write the failing tests** `src/features/graph/toFlow.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../../shared/ipc/types";
import { toFlow } from "./toFlow";

const n = (id: string, kind: GraphNode["kind"], name = id.split("/").pop()!): GraphNode => ({ id, kind, namespace: "p", name, status: "ok", badges: [], group: null });
const e = (source: string, target: string, relation: GraphEdge["relation"] = "owns"): GraphEdge => ({ id: `${source}->${target}:${relation}`, source, target, relation });

const nodes = new Map([n("Service/p/web", "Service"), n("Pod/p/a", "Pod"), n("ConfigMap/p/cfg", "ConfigMap")].map((x) => [x.id, x]));
const edges = new Map([e("Service/p/web", "Pod/p/a", "selects"), e("ConfigMap/p/cfg", "Pod/p/a", "envFrom")].map((x) => [x.id, x]));

describe("toFlow", () => {
  it("hides filtered kinds and their edges", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(["ConfigMap"]), search: "", hoveredId: null, selectedId: null, expandedGroups: new Set() });
    expect(f.nodes.map((x) => x.id).sort()).toEqual(["Pod/p/a", "Service/p/web"]);
    expect(f.edges.map((x) => x.id)).toEqual(["Service/p/web->Pod/p/a:selects"]);
  });

  it("marks search matches and dims the rest", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(), search: "WEB", hoveredId: null, selectedId: null, expandedGroups: new Set() });
    const byId = Object.fromEntries(f.nodes.map((x) => [x.id, x.data]));
    expect(byId["Service/p/web"].dimmed).toBe(false);
    expect(byId["Pod/p/a"].dimmed).toBe(true);
  });

  it("highlights edges touching the hovered node", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(), search: "", hoveredId: "Service/p/web", selectedId: null, expandedGroups: new Set() });
    const byId = Object.fromEntries(f.edges.map((x) => [x.id, x.data]));
    expect(byId["Service/p/web->Pod/p/a:selects"].highlighted).toBe(true);
    expect(byId["ConfigMap/p/cfg->Pod/p/a:envFrom"].highlighted).toBe(false);
  });

  it("sets selection and positions every node", () => {
    const f = toFlow({ nodes, edges, hiddenKinds: new Set(), search: "", hoveredId: null, selectedId: "Pod/p/a", expandedGroups: new Set() });
    expect(f.nodes.find((x) => x.id === "Pod/p/a")?.selected).toBe(true);
    expect(f.nodes.every((x) => Number.isFinite(x.position.x) && Number.isFinite(x.position.y))).toBe(true);
    expect(f.nodes.every((x) => x.type === "resource")).toBe(true);
    expect(f.edges.every((x) => x.type === "relation")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/features/graph/toFlow` → fails: cannot find `./toFlow`.

- [ ] **Step 3: Implement** `src/features/graph/toFlow.ts`

```ts
import type { Edge, Node } from "@xyflow/react";
import type { GraphEdge, GraphNode, Kind, NodeId } from "../../shared/ipc/types";
import { layout } from "./layout";

export interface ResourceNodeData extends Record<string, unknown> {
  node: GraphNode;
  dimmed: boolean;
  expanded: boolean;
}
export interface RelationEdgeData extends Record<string, unknown> {
  edge: GraphEdge;
  highlighted: boolean;
  dimmed: boolean;
}
export type ResourceFlowNode = Node<ResourceNodeData, "resource">;
export type RelationFlowEdge = Edge<RelationEdgeData, "relation">;

export interface ToFlowInput {
  nodes: Map<NodeId, GraphNode>;
  edges: Map<string, GraphEdge>;
  hiddenKinds: Set<Kind>;
  search: string;
  hoveredId: NodeId | null;
  selectedId: NodeId | null;
  expandedGroups: Set<NodeId>;
}

export function toFlow(input: ToFlowInput): { nodes: ResourceFlowNode[]; edges: RelationFlowEdge[] } {
  const visible = [...input.nodes.values()].filter((n) => !input.hiddenKinds.has(n.kind));
  const visibleIds = new Set(visible.map((n) => n.id));
  const visibleEdges = [...input.edges.values()].filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
  const positions = layout(visible, visibleEdges);

  const q = input.search.trim().toLowerCase();
  const matches = (n: GraphNode) => q === "" || n.name.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q);

  const nodes: ResourceFlowNode[] = visible.map((node) => ({
    id: node.id,
    type: "resource",
    position: positions.get(node.id)!,
    selected: node.id === input.selectedId,
    data: { node, dimmed: !matches(node), expanded: input.expandedGroups.has(node.id) },
  }));

  const hover = input.hoveredId;
  const edges: RelationFlowEdge[] = visibleEdges.map((edge) => {
    const touches = hover !== null && (edge.source === hover || edge.target === hover);
    return {
      id: edge.id,
      type: "relation",
      source: edge.source,
      target: edge.target,
      data: { edge, highlighted: touches, dimmed: hover !== null && !touches },
    };
  });

  return { nodes, edges };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/features/graph` → `10 passed`; `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Map store graph to React Flow nodes and edges with filters, search and hover"
```

---

### Task 5: Node card, edge and kind chips

**Files:**
- Create: `src/shared/ui/Dot.tsx`, `src/shared/ui/Chip.tsx`, `src/features/graph/kindMeta.ts`, `src/features/graph/ResourceNode.tsx`, `src/features/graph/RelationEdge.tsx`, `src/features/graph/KindChips.tsx`, `src/features/graph/ResourceNode.test.tsx`, `src/features/graph/KindChips.test.tsx`

- [ ] **Step 1: Write the failing tests**

`src/features/graph/ResourceNode.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../shared/ipc/types";
import { ResourceCard } from "./ResourceNode";

const node: GraphNode = { id: "Pod/p/web-1", kind: "Pod", namespace: "p", name: "web-1", status: "err", badges: ["CrashLoopBackOff", "↻ 14"], group: null };

describe("ResourceCard", () => {
  it("shows kind, name, badges and a status dot", () => {
    render(<ResourceCard node={node} dimmed={false} expanded={false} selected={false} />);
    expect(screen.getByText("Pod")).toBeInTheDocument();
    expect(screen.getByText("web-1")).toBeInTheDocument();
    expect(screen.getByText("CrashLoopBackOff")).toBeInTheDocument();
    expect(screen.getByText("↻ 14")).toBeInTheDocument();
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "err");
  });

  it("renders a pod group with its count and an expand hint", () => {
    const group: GraphNode = { ...node, id: "PodGroup/p/Deployment/web", kind: "PodGroup", name: "web", badges: ["×7", "6 ok · 1 err"], group: { count: 7, ok: 6, warn: 0, err: 1 } };
    render(<ResourceCard node={group} dimmed={false} expanded={false} selected={false} />);
    expect(screen.getByText("Pods")).toBeInTheDocument();
    expect(screen.getByText("×7")).toBeInTheDocument();
    expect(screen.getByTitle("Double-click to expand")).toBeInTheDocument();
  });

  it("dims when asked", () => {
    render(<ResourceCard node={node} dimmed expanded={false} selected={false} />);
    expect(screen.getByTestId("resource-card")).toHaveAttribute("data-dimmed", "true");
  });
});
```

`src/features/graph/KindChips.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KindChips } from "./KindChips";

describe("KindChips", () => {
  it("renders one chip per watched kind, marks hidden and denied kinds, toggles on click", () => {
    const onToggle = vi.fn();
    render(<KindChips hidden={new Set(["Secret"])} denied={new Set(["ConfigMap"])} present={new Set(["Pod", "Secret", "ConfigMap"])} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: /Secret/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Pod/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /ConfigMap/ })).toHaveAttribute("title", "No access (RBAC)");
    fireEvent.click(screen.getByRole("button", { name: /Secret/ }));
    expect(onToggle).toHaveBeenCalledWith("Secret");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/features/graph` → the two new files fail to resolve their imports.

- [ ] **Step 3: Implement**

`src/shared/ui/Dot.tsx`:
```tsx
import type { ConnectionState, Status } from "../ipc/types";

const COLORS: Record<Status | ConnectionState, string> = {
  ok: "bg-status-ok", warn: "bg-status-warn", err: "bg-status-err", unknown: "bg-status-unknown",
  connected: "bg-status-ok", degraded: "bg-status-warn", disconnected: "bg-status-err",
};

export function Dot({ status, className = "" }: { status: Status | ConnectionState; className?: string }) {
  return <span data-testid="status-dot" data-status={status} className={`inline-block size-2 rounded-full ${COLORS[status]} ${className}`} />;
}
```

`src/shared/ui/Chip.tsx`:
```tsx
import type { ButtonHTMLAttributes } from "react";

export function Chip({ active, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`no-drag rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        active ? "border-current-b bg-muted text-text-hi" : "border-border bg-surface text-text-muted hover:text-text"
      } ${className}`}
      {...rest}
    />
  );
}
```

`src/features/graph/kindMeta.ts`:
```ts
import type { Kind } from "../../shared/ipc/types";

/** Short label + letter used in the node icon. Order = chip order. */
export const KIND_META: Record<Kind, { label: string; letter: string; short: string }> = {
  Ingress: { label: "Ingress", letter: "I", short: "Ingress" },
  Service: { label: "Service", letter: "S", short: "Service" },
  Deployment: { label: "Deployment", letter: "D", short: "Deploy" },
  StatefulSet: { label: "StatefulSet", letter: "SS", short: "STS" },
  DaemonSet: { label: "DaemonSet", letter: "DS", short: "DS" },
  ReplicaSet: { label: "ReplicaSet", letter: "RS", short: "RS" },
  Job: { label: "Job", letter: "J", short: "Job" },
  CronJob: { label: "CronJob", letter: "CJ", short: "CronJob" },
  Pod: { label: "Pod", letter: "P", short: "Pod" },
  PodGroup: { label: "Pods", letter: "P", short: "Pods" },
  ConfigMap: { label: "ConfigMap", letter: "CM", short: "ConfigMap" },
  Secret: { label: "Secret", letter: "SE", short: "Secret" },
  PersistentVolumeClaim: { label: "PersistentVolumeClaim", letter: "PVC", short: "PVC" },
  PersistentVolume: { label: "PersistentVolume", letter: "PV", short: "PV" },
  ServiceAccount: { label: "ServiceAccount", letter: "SA", short: "SA" },
  HorizontalPodAutoscaler: { label: "HorizontalPodAutoscaler", letter: "HPA", short: "HPA" },
};

/** Kinds shown as filter chips (PodGroup follows Pod). */
export const CHIP_KINDS: Kind[] = [
  "Ingress", "Service", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod",
  "ConfigMap", "Secret", "PersistentVolumeClaim", "PersistentVolume", "ServiceAccount", "HorizontalPodAutoscaler",
];

/** Workload kinds get the gradient icon; everything else a muted one. */
export const GRADIENT_KINDS = new Set<Kind>(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Ingress"]);
```

`src/features/graph/ResourceNode.tsx`:
```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { GraphNode } from "../../shared/ipc/types";
import { Dot } from "../../shared/ui/Dot";
import { GRADIENT_KINDS, KIND_META } from "./kindMeta";
import { NODE_HEIGHT, NODE_WIDTH } from "./layout";
import type { ResourceFlowNode } from "./toFlow";

export function ResourceCard({ node, dimmed, expanded, selected }: { node: GraphNode; dimmed: boolean; expanded: boolean; selected: boolean }) {
  const meta = KIND_META[node.kind];
  const isGroup = node.kind === "PodGroup";
  const isPod = node.kind === "Pod";
  return (
    <div
      data-testid="resource-card"
      data-dimmed={dimmed}
      title={isGroup ? "Double-click to expand" : undefined}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`flex items-center gap-2.5 rounded-node border bg-surface px-3 transition-opacity ${
        selected ? "border-transparent shadow-[0_0_0_1.5px_#ff5c2c,0_0_14px_rgba(255,73,44,.35)]" : "border-border"
      } ${dimmed ? "opacity-30" : "opacity-100"}`}
    >
      {isPod || isGroup ? (
        <Dot status={node.status} className="size-2.5 shrink-0" />
      ) : (
        <span className={`grid size-6 shrink-0 place-items-center rounded-md text-[10px] font-semibold text-text-hi ${GRADIENT_KINDS.has(node.kind) ? "gradient-current" : "bg-muted"}`}>
          {meta.letter}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted">
          <span>{meta.label}</span>
          {!isPod && !isGroup && <Dot status={node.status} className="size-1.5" />}
          {isGroup && expanded && <span className="normal-case tracking-normal">(expanded)</span>}
        </div>
        <div className="truncate text-[13px] text-text-hi">{node.name}</div>
        {node.badges.length > 0 && (
          <div className="mt-0.5 flex gap-1 overflow-hidden">
            {node.badges.map((b) => (
              <span key={b} className={`truncate rounded-full bg-muted px-1.5 text-[10px] ${node.status === "err" ? "text-[#ff492c]" : "text-text"}`}>{b}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const ResourceNode = memo(function ResourceNode({ data, selected }: NodeProps<ResourceFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} className="!size-2 !border-void !bg-current-b" />
      <ResourceCard node={data.node} dimmed={data.dimmed} expanded={data.expanded} selected={!!selected} />
      <Handle type="source" position={Position.Right} className="!size-2 !border-void !bg-current-b" />
    </>
  );
});
```

`src/features/graph/RelationEdge.tsx`:
```tsx
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import type { RelationFlowEdge } from "./toFlow";

export const EDGE_GRADIENT_ID = "wiring-edge-gradient";

/** Rendered once inside the canvas so every edge can reference the gradient. */
export function EdgeGradientDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        <linearGradient id={EDGE_GRADIENT_ID} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#077ac7" />
          <stop offset="1" stopColor="#6b21ef" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export const RelationEdge = memo(function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const solid = data?.edge.relation === "owns";
  const opacity = data?.dimmed ? 0.15 : data?.highlighted ? 1 : 0.7;
  return (
    <BaseEdge
      path={path}
      style={{
        stroke: `url(#${EDGE_GRADIENT_ID})`,
        strokeWidth: data?.highlighted ? 2.5 : 1.5,
        strokeDasharray: solid ? undefined : "6 4",
        opacity,
        transition: "opacity 150ms, stroke-width 150ms",
      }}
    />
  );
});
```

`src/features/graph/KindChips.tsx`:
```tsx
import type { Kind } from "../../shared/ipc/types";
import { Chip } from "../../shared/ui/Chip";
import { CHIP_KINDS, KIND_META } from "./kindMeta";

export function KindChips({ hidden, denied, present, onToggle }: { hidden: Set<Kind>; denied: Set<Kind>; present: Set<Kind>; onToggle: (k: Kind) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CHIP_KINDS.map((kind) => {
        const isDenied = denied.has(kind);
        const has = present.has(kind) || (kind === "Pod" && present.has("PodGroup"));
        return (
          <Chip
            key={kind}
            active={!hidden.has(kind)}
            title={isDenied ? "No access (RBAC)" : undefined}
            className={`${has ? "" : "opacity-50"} ${isDenied ? "line-through" : ""}`}
            onClick={() => onToggle(kind)}
          >
            {KIND_META[kind].short}
          </Chip>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/features/graph` → `14 passed`; `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add node card, relation edge and kind filter chips"
```

---

### Task 6: Canvas

**Files:**
- Create: `src/features/graph/Canvas.tsx`, `src/features/graph/Canvas.test.tsx`

- [ ] **Step 1: Write the failing test** `src/features/graph/Canvas.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import { Canvas } from "./Canvas";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));

beforeEach(() => useAppStore.setState(initialState()));

describe("Canvas", () => {
  it("shows the empty state before a namespace is selected", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" } });
    render(<Canvas />);
    expect(screen.getByText(/select a namespace/i)).toBeInTheDocument();
  });

  it("shows the loading state after selecting a namespace until the snapshot arrives", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "payments" } });
    render(<Canvas />);
    expect(screen.getByText(/loading payments/i)).toBeInTheDocument();
  });

  it("shows the empty-namespace state for an empty snapshot", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "payments" },
    });
    render(<Canvas />);
    expect(screen.getByText(/namespace is empty/i)).toBeInTheDocument();
  });

  it("renders nodes from the store", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), { nodes: [{ id: "Pod/p/web-1", kind: "Pod", namespace: "p", name: "web-1", status: "ok", badges: ["Running"], group: null }], edges: [] }),
      connection: { ...initialState().connection, context: "prod", state: "connected", namespace: "p" },
    });
    render(<Canvas />);
    expect(screen.getByText("web-1")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/features/graph/Canvas` → cannot find `./Canvas`.

- [ ] **Step 3: Implement** `src/features/graph/Canvas.tsx`

```tsx
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, type NodeMouseHandler } from "@xyflow/react";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import type { Kind } from "../../shared/ipc/types";
import { KindChips } from "./KindChips";
import { EdgeGradientDefs, RelationEdge } from "./RelationEdge";
import { ResourceNode } from "./ResourceNode";
import { toFlow, type ResourceFlowNode } from "./toFlow";

const nodeTypes = { resource: ResourceNode };
const edgeTypes = { relation: RelationEdge };

export function Canvas() {
  const s = useAppStore(
    useShallow((s) => ({
      nodes: s.nodes, edges: s.edges, graphReady: s.graphReady, hiddenKinds: s.hiddenKinds, deniedKinds: s.deniedKinds,
      search: s.search, hoveredId: s.hoveredId, selectedId: s.selectedId, expandedGroups: s.expandedGroups,
      namespace: s.connection.namespace, context: s.connection.context,
      select: s.select, setHovered: s.setHovered, toggleGroup: s.toggleGroup, toggleKind: s.toggleKind,
    })),
  );

  const flow = useMemo(() => toFlow(s), [s.nodes, s.edges, s.hiddenKinds, s.search, s.hoveredId, s.selectedId, s.expandedGroups]);
  const present = useMemo(() => new Set<Kind>([...s.nodes.values()].map((n) => n.kind)), [s.nodes]);

  const onNodeClick = useCallback<NodeMouseHandler<ResourceFlowNode>>((_, node) => void s.select(node.id), [s.select]);
  const onNodeDoubleClick = useCallback<NodeMouseHandler<ResourceFlowNode>>((_, node) => {
    if (node.data.node.kind === "PodGroup") void s.toggleGroup(node.id);
  }, [s.toggleGroup]);
  const onNodeMouseEnter = useCallback<NodeMouseHandler<ResourceFlowNode>>((_, node) => s.setHovered(node.id), [s.setHovered]);
  const onNodeMouseLeave = useCallback(() => s.setHovered(null), [s.setHovered]);

  let overlay: string | null = null;
  if (!s.context) overlay = "Connect to a cluster to see its graph.";
  else if (!s.namespace) overlay = "Select a namespace to see its graph.";
  else if (!s.graphReady) overlay = `Loading ${s.namespace}…`;
  else if (s.nodes.size === 0) overlay = "Namespace is empty.";

  return (
    <div className="relative h-full w-full bg-void">
      <EdgeGradientDefs />
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={() => void s.select(null)}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#2c2834" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap pannable zoomable position="bottom-right" nodeColor="#2c2834" maskColor="rgba(14,9,24,0.7)" style={{ background: "#1a1624", bottom: 56 }} />
      </ReactFlow>
      <div className="pointer-events-none absolute inset-x-3 top-3 flex">
        <div className="pointer-events-auto">
          <KindChips hidden={s.hiddenKinds} denied={s.deniedKinds} present={present} onToggle={s.toggleKind} />
        </div>
      </div>
      {overlay && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-text-muted">{overlay}</div>
      )}
    </div>
  );
}
```

Note: React Flow's `fitView` only fits on mount; add a `useEffect` that calls `fitView()` via `useReactFlow()` when `graphReady` flips to `true` — wrap the component body in a `<ReactFlowProvider>` (export `Canvas` as the provider-wrapped version, keep the inner component as `CanvasInner`). Implement: `const { fitView } = useReactFlow(); useEffect(() => { if (s.graphReady) requestAnimationFrame(() => fitView({ padding: 0.2, maxZoom: 1 })); }, [s.graphReady, s.namespace]);`.

- [ ] **Step 4: Run tests**

Run: `pnpm test src/features/graph/Canvas` → `4 passed`. If React Flow logs "[React Flow]: The React Flow parent container needs a width and a height" in jsdom, that's a warning, not a failure. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add the graph canvas with filters, hover highlighting and empty states"
```

---

### Task 7: Header, context picker, namespace picker, settings

**Files:**
- Create: `src/shared/settings.ts`, `src/shared/ui/Button.tsx`, `src/features/cluster/Header.tsx`, `src/features/cluster/ContextPicker.tsx`, `src/features/cluster/NamespacePicker.tsx`, `src/features/cluster/cluster.test.tsx`

- [ ] **Step 1: Write the failing tests** `src/features/cluster/cluster.test.tsx`

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { ContextPicker } from "./ContextPicker";
import { Header } from "./Header";
import { NamespacePicker } from "./NamespacePicker";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/extra.kubeconfig") }));
vi.mock("../../shared/settings", () => ({ settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}) } }));

beforeEach(() => useAppStore.setState(initialState()));

describe("ContextPicker", () => {
  it("lists contexts and connects on click", async () => {
    const connect = vi.fn(async () => true);
    useAppStore.setState({ contexts: [{ name: "prod", cluster: "c", user: "u", namespace: null, sourceFile: "/k" }], connect, pickerOpen: true });
    render(<ContextPicker />);
    fireEvent.click(screen.getByRole("button", { name: /prod/ }));
    expect(connect).toHaveBeenCalledWith("prod");
  });

  it("shows instructions when there are no contexts", () => {
    useAppStore.setState({ contexts: [], pickerOpen: true });
    render(<ContextPicker />);
    expect(screen.getByText(/no kubeconfig contexts found/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add kubeconfig/i })).toBeInTheDocument();
  });
});

describe("NamespacePicker", () => {
  it("lists namespaces and selects one", () => {
    const selectNamespace = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: ["default", "payments"] }, selectNamespace });
    render(<NamespacePicker />);
    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: "payments" } });
    expect(selectNamespace).toHaveBeenCalledWith("payments");
  });

  it("falls back to a text input when the namespace list is empty", () => {
    const selectNamespace = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: [] }, selectNamespace });
    render(<NamespacePicker />);
    const input = screen.getByPlaceholderText(/namespace/i);
    fireEvent.change(input, { target: { value: "team-a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selectNamespace).toHaveBeenCalledWith("team-a");
  });
});

describe("Header", () => {
  it("shows the connection dot, the context and a Reconnect button", () => {
    const connect = vi.fn(async () => true);
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "degraded", serverVersion: "v1.33.0" }, connect });
    render(<Header />);
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "degraded");
    expect(screen.getByText("prod")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    expect(connect).toHaveBeenCalledWith("prod");
  });

  it("search box updates the store", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod" } });
    render(<Header />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "web" } });
    expect(useAppStore.getState().search).toBe("web");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/features/cluster` → cannot resolve the components.

- [ ] **Step 3: Implement**

`src/shared/settings.ts` (persisted via tauri-plugin-store; the backend owns `extraKubeconfigs` in the same file — never overwrite it):
```ts
import { load, type Store } from "@tauri-apps/plugin-store";

const FILE = "settings.json";
let store: Promise<Store> | null = null;
const open = () => (store ??= load(FILE, { autoSave: true }));

export const settings = {
  async get<T>(key: "lastContext" | "lastNamespace"): Promise<T | null> {
    try {
      return (await (await open()).get<T>(key)) ?? null;
    } catch {
      return null;
    }
  },
  async set(key: "lastContext" | "lastNamespace", value: string | null): Promise<void> {
    try {
      await (await open()).set(key, value);
    } catch {
      /* settings are a convenience; never block the UI */
    }
  },
};
```

`src/shared/ui/Button.tsx`:
```tsx
import type { ButtonHTMLAttributes } from "react";

export function Button({ variant = "ghost", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  const base = "no-drag rounded-lg px-3 py-1.5 text-sm transition-opacity disabled:opacity-50";
  const look = variant === "primary" ? "gradient-ember text-text-hi hover:opacity-90" : "border border-border bg-transparent text-text hover:bg-muted";
  return <button type="button" className={`${base} ${look} ${className}`} {...rest} />;
}
```

`src/features/cluster/ContextPicker.tsx`:
```tsx
import { open } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { settings } from "../../shared/settings";
import { Button } from "../../shared/ui/Button";

export function ContextPicker() {
  const { contexts, pickerOpen, connect, addKubeconfig, setPickerOpen, busy, current } = useAppStore(
    useShallow((s) => ({ contexts: s.contexts, pickerOpen: s.pickerOpen, connect: s.connect, addKubeconfig: s.addKubeconfig, setPickerOpen: s.setPickerOpen, busy: s.connection.busy, current: s.connection.context })),
  );
  if (!pickerOpen) return null;

  const pick = async (name: string) => {
    if (await connect(name)) {
      await settings.set("lastContext", name);
      setPickerOpen(false);
    }
  };
  const add = async () => {
    const path = await open({ multiple: false, directory: false, title: "Add kubeconfig file" });
    if (typeof path === "string") await addKubeconfig(path);
  };

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-void/80 backdrop-blur-sm">
      <div className="w-[480px] rounded-card border border-border bg-surface p-6">
        <h2 className="mb-1 text-lg text-text-hi">Choose a cluster</h2>
        <p className="mb-4 text-sm text-text-muted">Contexts from your kubeconfig files.</p>
        {contexts.length === 0 ? (
          <p className="mb-4 text-sm">No kubeconfig contexts found. Add a kubeconfig file, or set <code>KUBECONFIG</code> and restart.</p>
        ) : (
          <ul className="mb-4 max-h-80 overflow-auto">
            {contexts.map((c) => (
              <li key={c.name}>
                <button type="button" disabled={busy} onClick={() => void pick(c.name)}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-muted disabled:opacity-50">
                  <span className="text-text-hi">{c.name}</span>
                  <span className="truncate pl-4 text-xs text-text-muted">{c.cluster}{c.namespace ? ` · ${c.namespace}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-between">
          <Button onClick={() => void add()}>Add kubeconfig…</Button>
          {current && <Button onClick={() => setPickerOpen(false)}>Cancel</Button>}
        </div>
      </div>
    </div>
  );
}
```

`src/features/cluster/NamespacePicker.tsx`:
```tsx
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
```

`src/features/cluster/Header.tsx`:
```tsx
import { Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { Button } from "../../shared/ui/Button";
import { Dot } from "../../shared/ui/Dot";
import { NamespacePicker } from "./NamespacePicker";

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export function Header() {
  const { connection, search, setSearch, connect, setPickerOpen } = useAppStore(
    useShallow((s) => ({ connection: s.connection, search: s.search, setSearch: s.setSearch, connect: s.connect, setPickerOpen: s.setPickerOpen })),
  );
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className={`drag-region flex h-12 shrink-0 items-center gap-3 border-b border-border bg-void px-3 ${isMac ? "pl-20" : ""}`}>
      <span className="text-sm font-semibold tracking-wide text-text-hi">Wiring</span>
      <button type="button" className="no-drag rounded-lg border border-border bg-surface px-2.5 py-1 text-sm text-text-hi hover:bg-muted" onClick={() => setPickerOpen(true)}>
        ⎈ <span>{connection.context ?? "choose cluster"}</span>{connection.serverVersion ? <span className="ml-2 text-xs text-text-muted">{connection.serverVersion}</span> : null}
      </button>
      {connection.context && <NamespacePicker />}
      <div className="no-drag relative ml-auto">
        <Search className="pointer-events-none absolute left-2 top-1.5 size-4 text-text-muted" />
        <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search  ${isMac ? "⌘" : "Ctrl+"}K`}
          className="w-56 rounded-lg border border-border bg-surface py-1 pl-8 pr-2 text-sm text-text-hi outline-none focus:border-current-b" />
      </div>
      <Dot status={connection.state} className="size-2.5" />
      {connection.context && (
        <Button variant="primary" disabled={connection.busy} onClick={() => void connect(connection.context!)}>Reconnect</Button>
      )}
    </header>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/features/cluster` → `6 passed`; `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add header with context and namespace pickers, search and reconnect"
```

---

### Task 8: Details panel (Overview · YAML · Events)

**Files:**
- Create: `src/features/details/yaml.ts`, `src/features/details/OverviewTab.tsx`, `src/features/details/YamlTab.tsx`, `src/features/details/EventsTab.tsx`, `src/features/details/DetailsPanel.tsx`, `src/features/details/DetailsPanel.test.tsx`

- [ ] **Step 1: Write the failing tests** `src/features/details/DetailsPanel.test.tsx`

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import { DetailsPanel } from "./DetailsPanel";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));
vi.mock("./yaml", () => ({ highlightYaml: vi.fn(async (src: string) => `<pre class="shiki"><code>${src}</code></pre>`) }));

const node = { id: "Pod/p/web-1", kind: "Pod" as const, namespace: "p", name: "web-1", status: "ok" as const, badges: [], group: null };

beforeEach(() => {
  useAppStore.setState(
    {
      ...applySnapshot(initialState(), { nodes: [node, { ...node, id: "Service/p/web", kind: "Service", name: "web" }], edges: [] }),
      selectedId: "Pod/p/web-1",
      details: {
        nodeId: "Pod/p/web-1", loading: false,
        data: { yaml: "kind: Pod\nmetadata:\n  name: web-1\n", summary: [["Phase", "Running"], ["Node", "worker-3"]], related: ["Service/p/web"] },
        events: [{ name: "e1", type: "Warning", reason: "BackOff", message: "restarting", count: 3, firstTimestamp: null, lastTimestamp: "2026-09-17T10:00:00Z" }],
      },
    },
  );
});

describe("DetailsPanel", () => {
  it("shows the overview rows and related nodes; clicking a related node selects it", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ select });
    render(<DetailsPanel />);
    expect(screen.getByText("Phase")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Service.*web/ }));
    expect(select).toHaveBeenCalledWith("Service/p/web");
  });

  it("switches to the YAML tab and renders highlighted YAML", async () => {
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    expect(await screen.findByText(/kind: Pod/)).toBeInTheDocument();
  });

  it("lists events with Warning styling", () => {
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    const row = screen.getByText("BackOff").closest("tr")!;
    expect(row).toHaveAttribute("data-type", "Warning");
    expect(screen.getByText("restarting")).toBeInTheDocument();
  });

  it("shows a hint when nothing is selected", () => {
    useAppStore.setState({ selectedId: null, details: null });
    render(<DetailsPanel />);
    expect(screen.getByText(/select a node/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/features/details` → cannot resolve `./DetailsPanel`.

- [ ] **Step 3: Implement**

`src/features/details/yaml.ts` (shiki with the JS regex engine — no wasm, CSP-friendly):
```ts
import type { HighlighterCore } from "shiki/core";

let highlighter: Promise<HighlighterCore> | null = null;

async function get(): Promise<HighlighterCore> {
  return (highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, yaml, theme] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("@shikijs/langs/yaml"),
      import("@shikijs/themes/vesper"),
    ]);
    return createHighlighterCore({ langs: [yaml.default], themes: [theme.default], engine: createJavaScriptRegexEngine() });
  })());
}

/** Returns HTML for the YAML; falls back to escaped text if shiki fails to load. */
export async function highlightYaml(src: string): Promise<string> {
  try {
    return (await get()).codeToHtml(src, { lang: "yaml", theme: "vesper" });
  } catch {
    const esc = src.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    return `<pre class="shiki"><code>${esc}</code></pre>`;
  }
}
```
If `@shikijs/langs` / `@shikijs/themes` are not resolvable, run `pnpm add @shikijs/langs @shikijs/themes` (they are shiki's own sub-packages).

`src/features/details/OverviewTab.tsx`:
```tsx
import { useAppStore } from "../../app/store";
import type { NodeId, ObjectDetails } from "../../shared/ipc/types";
import { KIND_META } from "../graph/kindMeta";

export function OverviewTab({ data }: { data: ObjectDetails }) {
  const nodes = useAppStore((s) => s.nodes);
  const select = useAppStore((s) => s.select);
  const related = data.related.map((id: NodeId) => nodes.get(id)).filter((n) => n !== undefined);
  return (
    <div className="grid h-full grid-cols-[1fr_260px] gap-6 overflow-auto p-4 selectable">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
        {data.summary.map(([k, v], i) => (
          <div key={`${k}-${i}`} className="contents">
            <dt className="text-text-muted">{k}</dt>
            <dd className="break-all text-text-hi">{v || "—"}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">Related</div>
        <ul className="space-y-1">
          {related.map((n) => (
            <li key={n.id}>
              <button type="button" onClick={() => void select(n.id)} className="w-full truncate rounded-md bg-muted px-2 py-1 text-left text-xs hover:text-text-hi">
                <span className="text-text-muted">{KIND_META[n.kind].short}</span> {n.name}
              </button>
            </li>
          ))}
          {related.length === 0 && <li className="text-xs text-text-muted">Nothing connected.</li>}
        </ul>
      </div>
    </div>
  );
}
```

`src/features/details/YamlTab.tsx`:
```tsx
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { highlightYaml } from "./yaml";

export function YamlTab({ yaml }: { yaml: string }) {
  const [html, setHtml] = useState<string>("");
  useEffect(() => {
    let alive = true;
    void highlightYaml(yaml).then((h) => { if (alive) setHtml(h); });
    return () => { alive = false; };
  }, [yaml]);
  if (yaml === "") return <div className="p-4 text-sm text-text-muted">No YAML for this node.</div>;
  return (
    <div className="relative h-full overflow-auto selectable">
      <button type="button" title="Copy YAML" onClick={() => void navigator.clipboard.writeText(yaml)}
        className="absolute right-3 top-3 rounded-md border border-border bg-surface p-1.5 text-text-muted hover:text-text-hi">
        <Copy className="size-4" />
      </button>
      <div className="p-4 font-mono text-xs leading-5 [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
```

`src/features/details/EventsTab.tsx`:
```tsx
import type { K8sEvent } from "../../shared/ipc/types";

function age(ts: string | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function EventsTab({ events }: { events: K8sEvent[] }) {
  if (events.length === 0) return <div className="p-4 text-sm text-text-muted">No events.</div>;
  return (
    <div className="h-full overflow-auto selectable">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-panel text-left text-[10px] uppercase tracking-wider text-text-muted">
          <tr><th className="px-4 py-2">Type</th><th className="px-2 py-2">Reason</th><th className="px-2 py-2">Message</th><th className="px-2 py-2">Count</th><th className="px-4 py-2">Age</th></tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.name} data-type={e.type} className={`border-t border-border ${e.type === "Warning" ? "text-status-warn" : "text-text"}`}>
              <td className="px-4 py-1.5">{e.type}</td>
              <td className="px-2 py-1.5">{e.reason}</td>
              <td className="px-2 py-1.5 text-text-hi">{e.message}</td>
              <td className="px-2 py-1.5">{e.count}</td>
              <td className="px-4 py-1.5">{age(e.lastTimestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`src/features/details/DetailsPanel.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../app/store";
import { KIND_META } from "../graph/kindMeta";
import { EventsTab } from "./EventsTab";
import { OverviewTab } from "./OverviewTab";
import { YamlTab } from "./YamlTab";

type Tab = "overview" | "yaml" | "events";
const MIN = 120, MAX = 600, DEFAULT = 280;

export function DetailsPanel() {
  const { details, node } = useAppStore(useShallow((s) => ({ details: s.details, node: s.selectedId ? s.nodes.get(s.selectedId) : undefined })));
  const [tab, setTab] = useState<Tab>("overview");
  const [height, setHeight] = useState(DEFAULT);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { startY: e.clientY, startH: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [height]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    setHeight(Math.min(MAX, Math.max(MIN, drag.current.startH + (drag.current.startY - e.clientY))));
  }, []);
  const onPointerUp = useCallback(() => { drag.current = null; }, []);

  useEffect(() => { setTab("overview"); }, [details?.nodeId]);

  const tabs: { id: Tab; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "yaml", label: "YAML" }, { id: "events", label: "Events" }];

  return (
    <section className="shrink-0 border-t border-border bg-panel" style={{ height: collapsed ? 36 : height }}>
      <div className="h-1.5 cursor-row-resize hover:bg-current-b/40" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
      <div className="flex h-[30px] items-center gap-1 border-b border-border px-2">
        <div role="tablist" className="flex gap-1">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={`rounded-md px-2.5 py-0.5 text-xs ${tab === t.id ? "bg-muted text-text-hi" : "text-text-muted hover:text-text"}`}>
              {t.label}
            </button>
          ))}
        </div>
        {node && (
          <div className="ml-auto flex items-center gap-2 text-xs">
            <span className="text-text-hi">{node.name}</span>
            <span className="text-text-muted">{KIND_META[node.kind].label}{node.namespace ? ` · ${node.namespace}` : ""}</span>
          </div>
        )}
        <button type="button" className="ml-2 text-xs text-text-muted hover:text-text-hi" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand panel" : "Collapse panel"}>
          {collapsed ? "▴" : "▾"}
        </button>
      </div>
      {!collapsed && (
        <div className="h-[calc(100%-36px)]">
          {!details ? (
            <div className="grid h-full place-items-center text-sm text-text-muted">Select a node to see details</div>
          ) : details.loading || !details.data ? (
            <div className="grid h-full place-items-center text-sm text-text-muted">{details.loading ? "Loading…" : "Details unavailable"}</div>
          ) : tab === "overview" ? (
            <OverviewTab data={details.data} />
          ) : tab === "yaml" ? (
            <YamlTab yaml={details.data.yaml} />
          ) : (
            <EventsTab events={details.events} />
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/features/details` → `4 passed`; `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add details panel with overview, highlighted YAML and events"
```

---

### Task 9: Event wiring, startup, toasts, app shell

**Files:**
- Create: `src/app/wireEvents.ts`, `src/app/wireEvents.test.ts`, `src/app/startup.ts`, `src/app/startup.test.ts`, `src/shared/ui/Toasts.tsx`, `src/shared/ui/ErrorBoundary.tsx`
- Modify: `src/App.tsx`, `src/app/smoke.test.tsx`

- [ ] **Step 1: Write the failing tests**

`src/app/wireEvents.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandlers } from "../shared/ipc/events";
import { initialState, useAppStore } from "./store";

// vi.mock is hoisted above imports, so shared state must be hoisted too.
const hoisted = vi.hoisted(() => ({ handlers: null as EventHandlers | null }));
vi.mock("../shared/ipc/events", () => ({
  listenAll: vi.fn(async (h: EventHandlers) => { hoisted.handlers = h; return () => { hoisted.handlers = null; }; }),
}));
vi.mock("../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));

import { wireEvents } from "./wireEvents";

const node = { id: "Pod/p/a", kind: "Pod" as const, namespace: "p", name: "a", status: "ok" as const, badges: [], group: null };

beforeEach(() => { useAppStore.setState(initialState()); hoisted.handlers = null; });

`src/app/startup.test.ts`, `src/shared/ui/Toasts.tsx`, `src/shared/ui/ErrorBoundary.tsx`
- Modify: `src/App.tsx`, `src/app/smoke.test.tsx`

- [ ] **Step 1: Write the failing tests**

`src/app/wireEvents.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventHandlers } from "../shared/ipc/events";
import { initialState, useAppStore } from "./store";

// vi.mock is hoisted above imports, so shared state must be hoisted too.
const hoisted = vi.hoisted(() => ({ handlers: null as EventHandlers | null }));
vi.mock("../shared/ipc/events", () => ({
  listenAll: vi.fn(async (h: EventHandlers) => { hoisted.handlers = h; return () => { hoisted.handlers = null; }; }),
}));
vi.mock("../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));

import { wireEvents } from "./wireEvents";

const node = { id: "Pod/p/a", kind: "Pod" as const, namespace: "p", name: "a", status: "ok" as const, badges: [], group: null };

beforeEach(() => { useAppStore.setState(initialState()); hoisted.handlers = null; });

describe("wireEvents", () => {
  it("routes snapshot, delta, connection state, object events and errors into the store", async () => {
    const stop = await wireEvents();
    handlers!.graph_snapshot({ nodes: [node], edges: [] });
    expect(useAppStore.getState().nodes.size).toBe(1);
    handlers!.graph_delta({ addedNodes: [{ ...node, id: "Pod/p/b", name: "b" }], updatedNodes: [], removedNodes: [], addedEdges: [], removedEdges: [] });
    expect(useAppStore.getState().nodes.size).toBe(2);
    handlers!.connection_state("degraded");
    expect(useAppStore.getState().connection.state).toBe("degraded");
    useAppStore.setState({ selectedId: "Pod/p/a", details: { nodeId: "Pod/p/a", data: null, events: [], loading: false } });
    handlers!.object_events({ nodeId: "Pod/p/a", events: [{ name: "e", type: "Normal", reason: "Scheduled", message: "ok", count: 1, firstTimestamp: null, lastTimestamp: null }] });
    expect(useAppStore.getState().details?.events).toHaveLength(1);
    handlers!.object_events({ nodeId: "Pod/p/zzz", events: [] });
    expect(useAppStore.getState().details?.events).toHaveLength(1); // ignored: not the selection
    handlers!.connection_error({ kind: "forbidden", message: "Secret: forbidden" });
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "forbidden" });
    stop();
    expect(handlers).toBeNull();
  });

  it("a disconnected state reopens the context picker and clears the graph", async () => {
    await wireEvents();
    useAppStore.setState({ ...useAppStore.getState(), connection: { ...initialState().connection, context: "prod", state: "connected" } });
    handlers!.graph_snapshot({ nodes: [node], edges: [] });
    handlers!.connection_state("disconnected");
    const s = useAppStore.getState();
    expect(s.connection.state).toBe("disconnected");
    expect(s.nodes.size).toBe(0);
  });

  it("refreshes denied kinds when a per-kind forbidden error arrives", async () => {
    const { invoke } = await import("../shared/ipc/tauri");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "denied_kinds" ? ["Secret"] : null));
    await wireEvents();
    handlers!.connection_error({ kind: "forbidden", message: "Secret: forbidden" });
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().deniedKinds.has("Secret")).toBe(true);
  });
});
```

`src/app/startup.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "./store";

const { mem } = vi.hoisted(() => ({ mem: new Map<string, string | null>() }));
vi.mock("../shared/settings", () => ({
  settings: { get: vi.fn(async (k: string) => mem.get(k) ?? null), set: vi.fn(async (k: string, v: string | null) => { mem.set(k, v); }) },
}));
vi.mock("../shared/ipc/tauri", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "list_contexts") return [{ name: "prod", cluster: "c", user: "u", namespace: "payments", sourceFile: "/k" }];
    if (cmd === "connect") return { context: "prod", serverVersion: "v1", namespaces: ["default", "payments"] };
    if (cmd === "denied_kinds") return [];
    return null;
  }),
  listen: vi.fn(async () => () => {}),
}));

import { invoke } from "../shared/ipc/tauri";
import { startup } from "./startup";

beforeEach(() => { useAppStore.setState(initialState()); mem.clear(); vi.mocked(invoke).mockClear(); });

describe("startup", () => {
  it("opens the picker when there is no remembered context", async () => {
    await startup();
    expect(useAppStore.getState().pickerOpen).toBe(true);
    expect(useAppStore.getState().contexts).toHaveLength(1);
  });

  it("auto-connects the remembered context and namespace", async () => {
    mem.set("lastContext", "prod");
    mem.set("lastNamespace", "payments");
    await startup();
    const s = useAppStore.getState();
    expect(s.pickerOpen).toBe(false);
    expect(s.connection.context).toBe("prod");
    expect(s.connection.namespace).toBe("payments");
    expect(invoke).toHaveBeenCalledWith("select_namespace", { namespace: "payments", expandedGroups: [] });
  });

  it("falls back to the context's default namespace", async () => {
    mem.set("lastContext", "prod");
    await startup();
    expect(useAppStore.getState().connection.namespace).toBe("payments");
  });

  it("opens the picker when the remembered context no longer exists", async () => {
    mem.set("lastContext", "gone");
    await startup();
    expect(useAppStore.getState().pickerOpen).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("connect", expect.anything());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/app` → the two new files fail to resolve their imports.

- [ ] **Step 3: Implement**

`src/app/wireEvents.ts`:
```ts
import { commands } from "../shared/ipc/commands";
import { listenAll } from "../shared/ipc/events";
import { initialState, useAppStore } from "./store";

/** Subscribe backend events to the store. Returns an unsubscribe function. */
export function wireEvents(): Promise<() => void> {
  const s = () => useAppStore.getState();
  return listenAll({
    graph_snapshot: (g) => s().applySnapshot(g),
    graph_delta: (d) => s().applyDelta(d),
    object_events: ({ nodeId, events }) => s().setObjectEvents(nodeId, events),
    connection_state: (state) => {
      s().setConnectionState(state);
      if (state === "disconnected") {
        useAppStore.setState({ ...initialState(), contexts: s().contexts, hiddenKinds: s().hiddenKinds, pickerOpen: true });
      }
    },
    connection_error: (err) => {
      s().toast(err);
      if (err.kind === "forbidden" || err.kind === "notFound") {
        void commands.deniedKinds().then((kinds) => useAppStore.setState({ deniedKinds: new Set(kinds) })).catch(() => {});
      }
    },
  });
}
```

`src/app/startup.ts`:
```ts
import { settings } from "../shared/settings";
import { useAppStore } from "./store";

/** Boot: load contexts, reconnect the remembered context/namespace or open the picker. */
export async function startup(): Promise<void> {
  const s = useAppStore.getState;
  await s().loadContexts();
  const last = await settings.get<string>("lastContext");
  const ctx = last ? s().contexts.find((c) => c.name === last) : undefined;
  if (!ctx) {
    s().setPickerOpen(true);
    return;
  }
  if (!(await s().connect(ctx.name))) {
    s().setPickerOpen(true);
    return;
  }
  const remembered = await settings.get<string>("lastNamespace");
  const { namespaces } = s().connection;
  const ns = remembered && (namespaces.length === 0 || namespaces.includes(remembered)) ? remembered : ctx.namespace ?? null;
  if (ns) await s().selectNamespace(ns);
}
```

`src/shared/ui/Toasts.tsx`:
```tsx
import { X } from "lucide-react";
import { useEffect } from "react";
import { useAppStore } from "../../app/store";

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => dismiss(toasts[0].id), 8000);
    return () => clearTimeout(t);
  }, [toasts, dismiss]);
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-30 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role="alert" className="pointer-events-auto flex items-start gap-2 rounded-card border border-border bg-surface p-3 text-sm shadow-[0_0_8px_rgba(0,0,0,.26)]">
          <span className={`mt-1 size-2 shrink-0 rounded-full ${t.kind === "info" ? "bg-current-b" : "bg-status-err"}`} />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">{t.kind}</div>
            <div className="break-words text-text-hi">{t.message}</div>
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-text-muted hover:text-text-hi"><X className="size-4" /></button>
        </div>
      ))}
    </div>
  );
}
```

`src/shared/ui/ErrorBoundary.tsx`:
```tsx
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { name: string; children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`[${this.props.name}]`, error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-text-muted">
        <div>
          <div className="mb-2 text-text-hi">The {this.props.name} crashed.</div>
          <div className="mb-3 font-mono text-xs">{this.state.error.message}</div>
          <button type="button" className="rounded-lg border border-border px-3 py-1 hover:bg-muted" onClick={() => this.setState({ error: null })}>Reload view</button>
        </div>
      </div>
    );
  }
}
```

`src/App.tsx`:
```tsx
import { useEffect } from "react";
import { startup } from "./app/startup";
import { wireEvents } from "./app/wireEvents";
import { ContextPicker } from "./features/cluster/ContextPicker";
import { Header } from "./features/cluster/Header";
import { DetailsPanel } from "./features/details/DetailsPanel";
import { Canvas } from "./features/graph/Canvas";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary";
import { Toasts } from "./shared/ui/Toasts";

export function App() {
  useEffect(() => {
    let stop: (() => void) | undefined;
    void wireEvents().then((s) => { stop = s; }).then(startup);
    return () => stop?.();
  }, []);

  return (
    <div className="relative flex h-full flex-col">
      <Header />
      <main className="min-h-0 flex-1">
        <ErrorBoundary name="graph view"><Canvas /></ErrorBoundary>
      </main>
      <ErrorBoundary name="details panel"><DetailsPanel /></ErrorBoundary>
      <ContextPicker />
      <Toasts />
    </div>
  );
}
```

Update `src/app/smoke.test.tsx` to mock `../shared/ipc/tauri`, `../shared/settings` and `@tauri-apps/plugin-dialog` like the other tests and assert `screen.getByText("Wiring")` (the header logo) plus `screen.getByText(/connect to a cluster/i)`.

- [ ] **Step 4: Run tests**

Run: `pnpm test` → all green (expected total: 10 ipc + 9 store + 6 layout + 4 toFlow + 4 node/chips + 4 canvas + 6 cluster + 4 details + 3 wireEvents + 4 startup + 1 smoke = 55). `pnpm typecheck` and `pnpm build` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Wire backend events and startup into the app shell"
```

---

### Task 10: Run against a real cluster and polish

**Files:**
- Modify as needed: any file under `src/`; `src-tauri/tauri.conf.json` (CSP only if something is blocked)

This task is manual verification with a live cluster (Docker Desktop Kubernetes or another context). Fix what you find; keep tests green.

- [ ] **Step 1: Apply the smoke fixture so there is something to look at**

Run: `kubectl --context docker-desktop apply -f src-tauri/tests/fixtures/smoke.yaml` (namespace `wiring-smoke`: Deployment with 2 pods, Service, ConfigMap). Optionally scale to 7 replicas to see a PodGroup: `kubectl -n wiring-smoke scale deploy/web --replicas=7`.

- [ ] **Step 2: Start the app**

Run: `pnpm tauri dev`. Walk through: picker lists contexts → pick `docker-desktop` → choose `wiring-smoke` → graph appears (Service → Deployment → Pods/PodGroup, ConfigMap → Pods) → click a pod: Overview/YAML/Events fill → double-click the PodGroup: it expands → toggle the ConfigMap chip: it disappears and the layout tightens → type `web` in search → Reconnect: dot stays green, graph reloads → `kubectl -n wiring-smoke scale deploy/web --replicas=1`: pods vanish live. Check the devtools console (right-click → Inspect) for CSP violations or React warnings. Check macOS: traffic lights sit inside the header, header drags the window.

- [ ] **Step 3: Fix and polish**

Typical findings to address: `fitView` after the first snapshot, node card overflow with long names, minimap colours, CSP blocking fonts (`font-src` must include `'self' data:`), the details panel height, dimmed nodes still capturing hover. Every fix that changes behaviour gets a test.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Polish after first live run"
```

---

### Task 11: CI, release workflow, docs

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `README.md`, `docs/superpowers/specs/2026-09-17-wiring-mvp-design.md` (§5.4)

- [ ] **Step 1: CI workflow** `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:

jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build

  backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Tauri system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - uses: dtolnay/rust-toolchain@stable
        with: { components: clippy, rustfmt }
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: src-tauri }
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile && pnpm build   # generate_context! needs dist/
      - run: cargo fmt --check
        working-directory: src-tauri
      - run: cargo clippy --all-targets -- -D warnings
        working-directory: src-tauri
      - run: cargo test
        working-directory: src-tauri

  smoke:
    runs-on: ubuntu-latest
    needs: [backend]
    steps:
      - uses: actions/checkout@v4
      - uses: helm/kind-action@v1
        with: { cluster_name: kind }
      - name: Tauri system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: src-tauri }
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile && pnpm build
      - run: WIRING_SMOKE_CONTEXT=kind-kind cargo test --test smoke -- --ignored --nocapture
        working-directory: src-tauri
```

- [ ] **Step 2: Release workflow** `.github/workflows/release.yml`

```yaml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: --target universal-apple-darwin
          - platform: windows-latest
            args: ""
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}
      - uses: Swatinem/rust-cache@v2
        with: { workspaces: src-tauri }
      - run: pnpm install --frozen-lockfile
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "Wiring ${{ github.ref_name }}"
          releaseBody: "See the assets below. Builds are unsigned: on macOS run `xattr -d com.apple.quarantine Wiring.app`; on Windows choose *More info → Run anyway* in SmartScreen."
          releaseDraft: true
          args: ${{ matrix.args }}
```

- [ ] **Step 3: README**

Replace the Development section of `README.md` with:

````markdown
## Development

Prerequisites: Rust stable, Node 22, pnpm 9, and a kubeconfig with at least one context.

```bash
pnpm install
pnpm tauri dev          # app with hot reload
pnpm test               # frontend unit tests (Vitest)
pnpm typecheck
cd src-tauri && cargo test                                   # backend unit + IPC contract tests
WIRING_SMOKE_CONTEXT=docker-desktop cargo test --test smoke -- --ignored   # needs a live cluster + kubectl
```

## Releases

Tagging `v*` builds unsigned installers for macOS (universal `.dmg`) and Windows (`.msi`, `.exe`) via GitHub Actions and attaches them to a draft release. macOS: `xattr -d com.apple.quarantine Wiring.app` after download. Windows: SmartScreen → *More info* → *Run anyway*.
````

Keep the intro and the Docs section; add `- IPC contract: docs/ipc-contract.md` and `- Frontend plan: docs/superpowers/plans/2026-09-17-wiring-frontend.md` to Docs.

- [ ] **Step 4: Spec §5.4**

Replace the §5.4 paragraph that starts with "ELK `layered` algorithm" with: "Layout is a deterministic layered layout implemented in `src/features/graph/layout.ts`: one column per non-empty layer (layers as listed below), rows ordered by the barycenter of already-placed neighbours with id tie-breaks, orphans last. It runs synchronously on the main thread (≤ a few hundred nodes) and is stable across deltas; React Flow animates position changes." Keep the layer list.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm typecheck && pnpm build` green; `git add -A && git commit -m "Add CI and release workflows; document the frontend"`.

---

## Done criteria for this plan

- `pnpm test` green (≈55 tests), `pnpm typecheck` and `pnpm build` clean; `cargo test` still green.
- Manual walkthrough of Task 10 completed against a live cluster on macOS; findings fixed.
- CI workflow green on the branch; `release.yml` produces draft releases on `v*` tags (verified on the first tag).
- Next: merge `feat/backend` + `feat/frontend` into `master`, tag `v0.1.0`.
