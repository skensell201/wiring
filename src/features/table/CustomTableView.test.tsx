import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore, viewEditor } from "../../app/store";
import { headingFromId } from "../details/DetailsPanel";
import { invoke } from "../../shared/ipc/tauri";
import type { ResourceRef, Table } from "../../shared/ipc/types";
import { CustomTableView } from "./CustomTableView";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const cert: ResourceRef = { group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", namespaced: true };
const id = (n: string) => `Custom/cert-manager.io/v1/Certificate/shop/${n}`;
const table: Table = {
  kind: "Custom",
  columns: [{ key: "name", label: "Name", numeric: false }, { key: "c0", label: "Ready", numeric: false }, { key: "age", label: "Age", numeric: true }],
  rows: [
    { nodeId: id("web-tls"), status: "ok", cells: [{ text: "web-tls", status: null }, { text: "True", status: null }, { text: "3d", status: null }] },
    { nodeId: id("api-tls"), status: "err", cells: [{ text: "api-tls", status: null }, { text: "False", status: null }, { text: "1d", status: null }] },
  ],
};
const show = () => useAppStore.setState({
  connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop"] },
  view: { name: "custom", resource: cert }, customTables: new Map([["cert-manager.io/v1/Certificate", table]]),
});

beforeEach(() => { useAppStore.setState(initialState()); vi.mocked(invoke).mockReset(); });

describe("CustomTableView", () => {
  it("renders the printer columns and sorts by them", () => {
    show();
    render(<CustomTableView />);
    const grid = screen.getByRole("grid", { name: "Certificate" });
    expect(within(grid).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Ready", "Age"]);
    fireEvent.click(within(grid).getByRole("button", { name: "Name" }));
    expect(within(grid).getAllByRole("row").slice(1).map((r) => r.firstChild?.textContent)).toEqual(["api-tls", "web-tls"]);
  });

  it("selecting a row loads its details through get_object", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "get_object" ? { yaml: "kind: Certificate\n", summary: [["Name", "web-tls"]], related: [] } : null));
    show();
    render(<CustomTableView />);
    fireEvent.click(screen.getByText("web-tls"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_object", { nodeId: id("web-tls") }));
    expect(useAppStore.getState().selectedId).toBe(id("web-tls"));
  });

  it("says when the kind has no objects in the scope", () => {
    show();
    useAppStore.setState({ customTables: new Map([["cert-manager.io/v1/Certificate", { ...table, rows: [] }]]) });
    render(<CustomTableView />);
    expect(screen.getByRole("status", { name: "Nothing here yet" })).toHaveTextContent("shop has no certificates.");
    fireEvent.click(screen.getByRole("button", { name: "+ Create" }));
    expect(useAppStore.getState().createDialog).toMatchObject({ open: true, custom: cert });
  });

  it("does not ask for a namespace on a cluster-scoped kind with no objects", () => {
    const issuer: ResourceRef = { group: "cert-manager.io", version: "v1", kind: "ClusterIssuer", plural: "clusterissuers", namespaced: false };
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop"] },
      view: { name: "custom", resource: issuer }, customTables: new Map([["cert-manager.io/v1/ClusterIssuer", { ...table, rows: [] }]]),
    });
    render(<CustomTableView />);
    expect(screen.getByRole("status", { name: "Nothing here yet" })).toHaveTextContent("The cluster has no clusterissuers.");
    expect(screen.queryByRole("button", { name: /namespace/i })).toBeNull();
  });

  it("shows the watch's terminal error instead of the rows, with a Retry that lists again", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "list_custom" ? { resource: cert, table, error: null } : null));
    show();
    useAppStore.setState({
      customTables: new Map([["cert-manager.io/v1/Certificate", { ...table, rows: [] }]]),
      customTableErrors: new Map([["cert-manager.io/v1/Certificate", "No access to Certificate (RBAC)"]]),
    });
    render(<CustomTableView />);
    expect(screen.getByText("No access to Certificate (RBAC)")).toBeInTheDocument();
    expect(screen.getByRole("alert", { name: "Can't list Certificate" })).toBeInTheDocument();
    expect(screen.queryByText(/has no certificates/)).toBeNull();
    expect(screen.queryByRole("grid")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_custom", { resource: cert }));
    // The answer clears the error and brings the rows back.
    expect(await screen.findByRole("grid", { name: "Certificate" })).toBeInTheDocument();
    expect(useAppStore.getState().customTableErrors.size).toBe(0);
  });

  it("headings of custom ids show the custom kind's name and namespace", () => {
    expect(headingFromId(id("web-tls"))).toEqual({ name: "web-tls", kind: "Custom", namespace: "shop" });
  });

  it("double-clicking a row that is not on the graph does nothing", () => {
    const focusInGraph = vi.fn(async () => {});
    show();
    useAppStore.setState({ focusInGraph });
    render(<CustomTableView />);
    fireEvent.doubleClick(screen.getByText("web-tls"));
    expect(focusInGraph).not.toHaveBeenCalled();
    const node = { id: id("web-tls"), kind: "Custom" as const, namespace: "shop", name: "web-tls", status: "ok" as const, badges: [], group: null };
    act(() => useAppStore.setState({ nodes: new Map([[node.id, node]]) }));
    fireEvent.doubleClick(screen.getByText("web-tls"));
    expect(focusInGraph).toHaveBeenCalledWith(id("web-tls"));
  });
});

describe("the selection of a custom resource", () => {
  const selected = (nodeId: string) => ({
    selectedId: nodeId,
    details: { nodeId, loading: false, editor: viewEditor("kind: Certificate\n"), data: { yaml: "kind: Certificate\n", summary: [], related: [] }, events: [] },
  });

  it("clears after deleting it from the details panel", async () => {
    show();
    useAppStore.setState({ ...selected(id("web-tls")), deleteDialog: { open: true, nodeId: id("web-tls") } });
    await useAppStore.getState().confirmDelete();
    expect(invoke).toHaveBeenCalledWith("delete_object", { nodeId: id("web-tls") });
    expect(useAppStore.getState().selectedId).toBeNull();
    expect(useAppStore.getState().details).toBeNull();
  });

  it("clears when a table update drops its row", () => {
    show();
    useAppStore.setState(selected(id("web-tls")));
    useAppStore.getState().applyCustomTable({ resource: cert, table: { ...table, rows: table.rows.slice(1) }, error: null });
    expect(useAppStore.getState().selectedId).toBeNull();
    expect(useAppStore.getState().details).toBeNull();
  });

  it("survives an update that does not carry a just-created object's row yet", () => {
    show();
    useAppStore.setState(selected(id("new-tls")));
    useAppStore.getState().applyCustomTable({ resource: cert, table, error: null });
    expect(useAppStore.getState().selectedId).toBe(id("new-tls"));
  });

  it("survives a terminal error, which empties the rows without deleting anything", () => {
    show();
    useAppStore.setState(selected(id("web-tls")));
    useAppStore.getState().applyCustomTable({ resource: cert, table: { ...table, rows: [] }, error: "No access to Certificate (RBAC)" });
    expect(useAppStore.getState().selectedId).toBe(id("web-tls"));
  });
});
