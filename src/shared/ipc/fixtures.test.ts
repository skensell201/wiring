import { describe, expect, it } from "vitest";
import appError from "./fixtures/app_error.json";
import connectInfo from "./fixtures/connect_info.json";
import connectionState from "./fixtures/connection_state.json";
import contextInfo from "./fixtures/context_info.json";
import customKind from "./fixtures/custom_kind.json";
import customTable from "./fixtures/custom_table.json";
import execMessage from "./fixtures/exec_message.json";
import execPod from "./fixtures/exec_pod.json";
import forward from "./fixtures/forward.json";
import helmRelease from "./fixtures/helm_release.json";
import helmReleaseDetails from "./fixtures/helm_release_details.json";
import kubeconfigSource from "./fixtures/kubeconfig_source.json";
import graph from "./fixtures/graph.json";
import graphExtras from "./fixtures/graph_extras.json";
import graphTooLarge from "./fixtures/graph_too_large.json";
import graphDelta from "./fixtures/graph_delta.json";
import logMessage from "./fixtures/log_message.json";
import metricsUpdated from "./fixtures/metrics_updated.json";
import objectDetails from "./fixtures/object_details.json";
import objectEvents from "./fixtures/object_events.json";
import portOption from "./fixtures/port_option.json";
import revision from "./fixtures/revision.json";
import table from "./fixtures/table.json";
import updateCheck from "./fixtures/update_check.json";
import updateProgress from "./fixtures/update_progress.json";
import {
  CONNECTION_STATES, ERROR_KINDS, KINDS, RELATIONS, STATUSES,
  isAppError, isConnectInfo, isConnectionState, isContextInfo, isKubeconfigSource, isCustomKind, isCustomTable, isHelmRelease, isHelmReleaseDetails, isExecMessage, isExecPod, isForward, isGraph, isGraphDelta, isGraphNode, isLogMessage, isMetricsUpdate, isObjectDetails, isObjectEvents, isPortOption, isRevision, isTable, isUpdateCheck, isUpdateProgress,
} from "./types";

// The JSON files are the contract shared with the Rust side (guarded there by
// src-tauri/tests/ipc_fixtures.rs). These guards make sure the TS mirrors keep up.
describe("IPC fixtures match the TypeScript types", () => {
  it("custom_kind", () => expect(isCustomKind(customKind)).toBe(true));
  it("custom_table", () => expect(isCustomTable(customTable)).toBe(true));
  it("rejects a custom table of a built-in kind", () => expect(isCustomTable({ ...customTable, table: { ...customTable.table, kind: "Pod" } })).toBe(false));
  it("accepts a custom table that ended with an error", () =>
    expect(isCustomTable({ ...customTable, table: { ...customTable.table, rows: [] }, error: "No access to Certificate (RBAC)" })).toBe(true));
  it("rejects a custom table without an error field", () => {
    const { error: _error, ...rest } = customTable;
    expect(isCustomTable(rest)).toBe(false);
  });
  it("helm_release", () => expect(isHelmRelease(helmRelease)).toBe(true));
  it("rejects a helm release with an unknown health", () => expect(isHelmRelease({ ...helmRelease, health: "great" })).toBe(false));
  it("helm_release_details", () => expect(isHelmReleaseDetails(helmReleaseDetails)).toBe(true));
  it("context_info", () => expect(isContextInfo(contextInfo)).toBe(true));
  it("kubeconfig_source", () => expect(isKubeconfigSource(kubeconfigSource)).toBe(true));
  it("rejects a kubeconfig source with an unknown state", () => expect(isKubeconfigSource({ ...kubeconfigSource, state: "broken" })).toBe(false));
  it("rejects a kubeconfig source with a negative or fractional context count", () => {
    expect(isKubeconfigSource({ ...kubeconfigSource, contexts: -1 })).toBe(false);
    expect(isKubeconfigSource({ ...kubeconfigSource, contexts: 1.5 })).toBe(false);
  });
  it("connect_info", () => expect(isConnectInfo(connectInfo)).toBe(true));
  it("graph", () => expect(isGraph(graph)).toBe(true));
  it("accepts a graph with policies, RBAC and nodes", () => expect(isGraph(graphExtras)).toBe(true));
  it("graph_too_large", () => expect(isGraph(graphTooLarge)).toBe(true));
  it("rejects a graph with a broken tooLarge", () => expect(isGraph({ nodes: [], edges: [], tooLarge: { nodes: "many", kinds: [] } })).toBe(false));
  it("graph_delta", () => expect(isGraphDelta(graphDelta)).toBe(true));
  it("object_details", () => expect(isObjectDetails(objectDetails)).toBe(true));
  it("object_events", () => expect(isObjectEvents(objectEvents)).toBe(true));
  it("connection_state", () => expect(isConnectionState(connectionState)).toBe(true));
  it("app_error", () => expect(isAppError(appError)).toBe(true));
  it("table", () => expect(isTable(table)).toBe(true));
  it("forward", () => expect(isForward(forward)).toBe(true));
  it("port_option", () => expect(isPortOption(portOption)).toBe(true));
  it("rejects a forward with an unknown status", () => {
    expect(isForward({ ...forward, status: "sleeping" })).toBe(false);
  });
  it("metrics_updated", () => expect(isMetricsUpdate(metricsUpdated)).toBe(true));
  it("rejects a metrics update with an unknown state", () => {
    expect(isMetricsUpdate({ state: "sleeping" })).toBe(false);
  });
  it("update_check", () => expect(isUpdateCheck(updateCheck)).toBe(true));
  it("update_check without an offer", () => expect(isUpdateCheck({ current: "0.2.0", update: null })).toBe(true));
  it("rejects an update_check without a current version", () => expect(isUpdateCheck({ update: null })).toBe(false));
  it("update_progress", () => {
    expect(isUpdateProgress(updateProgress)).toBe(true);
    expect(isUpdateProgress({ downloaded: 1, total: null })).toBe(true);
  });
  it("log_message", () => expect(isLogMessage(logMessage)).toBe(true));

  it("revision", () => expect(isRevision(revision)).toBe(true));

  it("rejects a revision without images", () => {
    expect(isRevision({ ...revision, images: undefined })).toBe(false);
  });

  it("enum lists match docs/ipc-contract.md", () => {
    expect(KINDS).toHaveLength(23);
    expect(KINDS).toContain("PodGroup");
    expect(STATUSES).toEqual(["ok", "warn", "err", "unknown"]);
    expect(RELATIONS).toEqual(["owns", "selects", "routes", "mounts", "envFrom", "claims", "binds", "usesSA", "scales", "applies", "allows", "grants", "subject", "runsOn"]);
    expect(ERROR_KINDS).toEqual(["auth", "network", "forbidden", "notFound", "conflict", "invalid", "internal"]);
    expect(CONNECTION_STATES).toEqual(["connected", "degraded", "disconnected"]);
  });

  it("rejects a node with an unknown status", () => {
    const bad = { ...graph, nodes: [{ ...graph.nodes[0], status: "green" }] };
    expect(isGraph(bad)).toBe(false);
  });

  it("rejects a table row whose cell count does not match the columns", () => {
    const bad = { ...table, rows: [{ ...table.rows[0], cells: table.rows[0].cells.slice(0, 1) }] };
    expect(isTable(bad)).toBe(false);
  });

  it("rejects a log message with an unknown type", () => {
    expect(isLogMessage({ type: "bogus", sessionId: 1 })).toBe(false);
    expect(isLogMessage({ type: "lines", sessionId: 1, lines: [{ pod: "p" }] })).toBe(false);
  });

  it("graph nodes carry an optional problem", () => {
    const group = graph.nodes[1];
    expect(group.problem?.reason).toBe("1 of 7 pods: CrashLoopBackOff");
    expect(isGraphNode(group)).toBe(true);
    expect(isGraphNode(graph.nodes[0])).toBe(true); // no problem key at all
    expect(isGraphNode({ ...group, problem: { reason: 3, message: null, cause: null } })).toBe(false);
    expect(isGraphNode({ ...group, problem: { reason: "x", message: null } })).toBe(false);
  });
  it("exec_message", () => expect(isExecMessage(execMessage)).toBe(true));
  it("exec_pod", () => expect(isExecPod(execPod)).toBe(true));
  it("exec message variants", () => {
    expect(isExecMessage({ type: "ended", sessionId: 1, code: 3, message: null })).toBe(true);
    expect(isExecMessage({ type: "ended", sessionId: 1, code: null, message: "x" })).toBe(true);
    expect(isExecMessage({ type: "error", sessionId: 1, message: "x" })).toBe(true);
    expect(isExecMessage({ type: "output", sessionId: 1 })).toBe(false);
    expect(isExecPod({ name: "p", containers: [1] })).toBe(false);
  });
});
