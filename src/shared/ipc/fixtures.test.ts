import { describe, expect, it } from "vitest";
import appError from "./fixtures/app_error.json";
import connectInfo from "./fixtures/connect_info.json";
import connectionState from "./fixtures/connection_state.json";
import contextInfo from "./fixtures/context_info.json";
import graph from "./fixtures/graph.json";
import graphDelta from "./fixtures/graph_delta.json";
import logMessage from "./fixtures/log_message.json";
import objectDetails from "./fixtures/object_details.json";
import objectEvents from "./fixtures/object_events.json";
import revision from "./fixtures/revision.json";
import table from "./fixtures/table.json";
import {
  CONNECTION_STATES, ERROR_KINDS, KINDS, RELATIONS, STATUSES,
  isAppError, isConnectInfo, isConnectionState, isContextInfo, isGraph, isGraphDelta, isLogMessage, isObjectDetails, isObjectEvents, isRevision, isTable,
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
  it("table", () => expect(isTable(table)).toBe(true));
  it("log_message", () => expect(isLogMessage(logMessage)).toBe(true));

  it("revision", () => expect(isRevision(revision)).toBe(true));

  it("rejects a revision without images", () => {
    expect(isRevision({ ...revision, images: undefined })).toBe(false);
  });

  it("enum lists match docs/ipc-contract.md", () => {
    expect(KINDS).toHaveLength(16);
    expect(KINDS).toContain("PodGroup");
    expect(STATUSES).toEqual(["ok", "warn", "err", "unknown"]);
    expect(RELATIONS).toEqual(["owns", "selects", "routes", "mounts", "envFrom", "claims", "binds", "usesSA", "scales"]);
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
});
