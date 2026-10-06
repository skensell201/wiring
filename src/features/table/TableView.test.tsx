import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import type { Table } from "../../shared/ipc/types";
import { TableView } from "./TableView";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const pods: Table = {
  kind: "Pod",
  columns: [
    { key: "name", label: "Name", numeric: false },
    { key: "status", label: "Status", numeric: false },
    { key: "restarts", label: "Restarts", numeric: true },
  ],
  rows: [
    { nodeId: "Pod/payments/web-1", status: "err", cells: [{ text: "web-1", status: null }, { text: "CrashLoopBackOff", status: "err" }, { text: "14", status: null }] },
    { nodeId: "Pod/payments/api", status: "ok", cells: [{ text: "api", status: null }, { text: "Running", status: "ok" }, { text: "0", status: null }] },
    { nodeId: "Pod/payments/db", status: "ok", cells: [{ text: "db", status: null }, { text: "Running", status: "ok" }, { text: "3", status: null }] },
  ],
};
const connected = () => ({ ...initialState().connection, context: "prod", state: "connected" as const, scope: ["payments"] });
const bodyRows = () => within(screen.getAllByRole("rowgroup")[1]).getAllByRole("row");
const names = () => bodyRows().map((r) => within(r).getAllByRole("cell")[0].textContent);

beforeEach(() => {
  useAppStore.setState({ ...initialState(), connection: connected(), graphReady: true, view: { name: "table", kind: "Pod" }, tables: new Map([["Pod", pods]]) });
});

describe("TableView", () => {
  it("renders the columns and the rows sorted by name", () => {
    render(<TableView />);
    for (const label of ["Name", "Status", "Restarts"]) expect(screen.getByRole("columnheader", { name: new RegExp(label) })).toBeInTheDocument();
    expect(names()).toEqual(["api", "db", "web-1"]);
    expect(screen.getByText("CrashLoopBackOff")).toHaveAttribute("data-status", "err");
    expect(screen.getByText("14").className).toMatch(/tabular-nums/);
  });

  it("sorts by a column on header click, reverses on the second and clears on the third", () => {
    render(<TableView />);
    const restarts = screen.getByRole("columnheader", { name: /restarts/i });
    fireEvent.click(within(restarts).getByRole("button"));
    expect(names()).toEqual(["api", "db", "web-1"]);
    expect(restarts).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(within(restarts).getByRole("button"));
    expect(names()).toEqual(["web-1", "db", "api"]);
    expect(restarts).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(within(restarts).getByRole("button"));
    expect(names()).toEqual(["api", "db", "web-1"]);
    expect(restarts).not.toHaveAttribute("aria-sort");
  });

  it("filters rows by the header search", () => {
    render(<TableView />);
    act(() => useAppStore.getState().setSearch("crash"));
    expect(names()).toEqual(["web-1"]);
    act(() => useAppStore.getState().setSearch("nothing-here"));
    expect(screen.getByText(/no pods match/i)).toBeInTheDocument();
  });

  it("selects a row on click and marks the selected one", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ select, selectedId: "Pod/payments/db" });
    render(<TableView />);
    const [api, db] = bodyRows();
    expect(db).toHaveAttribute("aria-selected", "true");
    expect(api).toHaveAttribute("aria-selected", "false");
    fireEvent.click(api);
    expect(select).toHaveBeenCalledWith("Pod/payments/api");
  });

  it("shows a row in the graph on double-click", () => {
    const focusInGraph = vi.fn(async () => {});
    useAppStore.setState({ focusInGraph });
    render(<TableView />);
    fireEvent.doubleClick(bodyRows()[2]);
    expect(focusInGraph).toHaveBeenCalledWith("Pod/payments/web-1");
  });

  it("moves the selection with the arrow keys and shows it in the graph on Enter", () => {
    const select = vi.fn(async () => {});
    const focusInGraph = vi.fn(async () => {});
    useAppStore.setState({ select, focusInGraph, selectedId: "Pod/payments/db" });
    render(<TableView />);
    const table = screen.getByRole("grid");
    fireEvent.keyDown(table, { key: "ArrowDown" });
    expect(select).toHaveBeenLastCalledWith("Pod/payments/web-1");
    fireEvent.keyDown(table, { key: "ArrowUp" });
    expect(select).toHaveBeenLastCalledWith("Pod/payments/api");
    fireEvent.keyDown(table, { key: "Enter" });
    expect(focusInGraph).toHaveBeenCalledWith("Pod/payments/db");
  });

  it("ArrowDown with nothing selected picks the first row", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ select, selectedId: null });
    render(<TableView />);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown" });
    expect(select).toHaveBeenCalledWith("Pod/payments/api");
  });

  it("is a focusable grid with a visible focus ring", () => {
    render(<TableView />);
    const grid = screen.getByRole("grid", { name: "Pods" });
    expect(grid).toHaveAttribute("tabindex", "0");
    expect(grid.className).toMatch(/focus-visible:ring-1/);
  });

  it("scrolls a row selected with the keyboard into view, but not one selected by click", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const select = vi.fn(async (id: string | null) => { useAppStore.setState({ selectedId: id }); });
    useAppStore.setState({ select, selectedId: "Pod/payments/api" });
    render(<TableView />);
    fireEvent.click(bodyRows()[1]);
    await waitFor(() => expect(bodyRows()[1]).toHaveAttribute("aria-selected", "true"));
    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
    expect(scrollIntoView.mock.instances[0]).toBe(bodyRows()[2]);
  });

  it("shows the empty state for a kind with no rows", () => {
    useAppStore.setState({ tables: new Map([["Pod", { ...pods, rows: [] }]]) });
    render(<TableView />);
    expect(screen.getByText("No Pods in payments")).toBeInTheDocument();
  });

  it("shows the RBAC state for a denied kind", () => {
    useAppStore.setState({ view: { name: "table", kind: "Secret" }, deniedKinds: new Set(["Secret"]), tables: new Map() });
    render(<TableView />);
    expect(screen.getByText("No access to Secrets (RBAC)")).toBeInTheDocument();
  });

  it("shows a loading state until the table arrives", () => {
    useAppStore.setState({ tables: new Map() });
    render(<TableView />);
    expect(screen.getByText(/loading pods/i)).toBeInTheDocument();
  });

  it("shows a loading state instead of a stale table until the namespace's snapshot arrives", () => {
    // Between select_namespace and graph_snapshot the rows are not refetched yet; a leftover
    // (or empty) table must not read as the new namespace's contents.
    useAppStore.setState({ graphReady: false, tables: new Map([["Pod", { ...pods, rows: [] }]]) });
    render(<TableView />);
    expect(screen.getByText(/loading pods/i)).toBeInTheDocument();
    expect(screen.queryByText(/no pods in/i)).not.toBeInTheDocument();
  });

  it("right-clicking a row opens the Actions menu for it", () => {
    render(<TableView />);
    fireEvent.contextMenu(screen.getByText("db"), { clientX: 30, clientY: 40 });
    expect(useAppStore.getState().actionsMenu).toEqual({ nodeId: "Pod/payments/db", x: 30, y: 40 });
  });

  it("renders a leading Namespace column and the search filters on it", () => {
    const multi: Table = {
      kind: "Pod",
      columns: [{ key: "namespace", label: "Namespace", numeric: false }, { key: "name", label: "Name", numeric: false }],
      rows: [
        { nodeId: "Pod/shop/web", status: "ok", cells: [{ text: "shop", status: null }, { text: "web", status: null }] },
        { nodeId: "Pod/blog/web", status: "ok", cells: [{ text: "blog", status: null }, { text: "web", status: null }] },
      ],
    };
    useAppStore.setState({ connection: { ...connected(), scope: ["shop", "blog"] }, tables: new Map([["Pod", multi]]), search: "blog" });
    render(<TableView />);
    expect(screen.getAllByRole("columnheader")[0]).toHaveTextContent("Namespace");
    expect(bodyRows()).toHaveLength(1);
    expect(within(bodyRows()[0]).getAllByRole("cell")[0]).toHaveTextContent("blog");
  });
});

it("the Secrets table can show Helm's storage Secrets", async () => {
  const secrets = { kind: "Secret" as const, columns: [{ key: "name", label: "Name", numeric: false }], rows: [] };
  vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "list_rows" ? secrets : null));
  useAppStore.setState({
    connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop"] },
    graphReady: true, view: { name: "table", kind: "Secret" }, tables: new Map([["Secret", secrets]]),
  });
  render(<TableView />);
  const toggle = screen.getByRole("checkbox", { name: "Show Helm storage" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_rows", { kind: "Secret", includeHelmStorage: true }));
  expect(useAppStore.getState().includeHelmStorage).toBe(true);
});

it("a later refresh of the Secrets table keeps asking for Helm storage", async () => {
  const secrets = { kind: "Secret" as const, columns: [], rows: [] };
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "list_rows" ? secrets : null));
  useAppStore.setState({ includeHelmStorage: true });
  await useAppStore.getState().refreshTable("Secret");
  await useAppStore.getState().refreshTable("ConfigMap");
  expect(invoke).toHaveBeenCalledWith("list_rows", { kind: "Secret", includeHelmStorage: true });
  expect(invoke).toHaveBeenCalledWith("list_rows", { kind: "ConfigMap", includeHelmStorage: false });
});

it("other tables have no Helm storage toggle", () => {
  useAppStore.setState({ graphReady: true, view: { name: "table", kind: "ConfigMap" }, tables: new Map([["ConfigMap", { kind: "ConfigMap", columns: [], rows: [] }]]) });
  render(<TableView />);
  expect(screen.queryByRole("checkbox", { name: "Show Helm storage" })).toBeNull();
});

it("toggling Helm storage off asks for the plain list, and a late 'on' answer cannot overwrite it", async () => {
  const mk = (name: string): Table => ({ kind: "Secret", columns: [{ key: "name", label: "Name", numeric: false }], rows: [{ nodeId: `Secret/shop/${name}`, status: "ok", cells: [{ text: name, status: null }] }] });
  const resolvers: Array<(t: Table) => void> = [];
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation((cmd: string) => (cmd === "list_rows" ? new Promise<Table>((res) => { resolvers.push(res); }) : Promise.resolve(null)) as Promise<never>);
  useAppStore.setState({
    connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop"] },
    graphReady: true, view: { name: "table", kind: "Secret" }, tables: new Map([["Secret", mk("initial")]]),
  });
  render(<TableView />);
  const toggle = screen.getByRole("checkbox", { name: "Show Helm storage" });
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect(invoke).toHaveBeenCalledWith("list_rows", { kind: "Secret", includeHelmStorage: false });
  expect(resolvers).toHaveLength(2);
  await act(async () => { resolvers[1](mk("off")); });
  await act(async () => { resolvers[0](mk("on")); });
  expect(useAppStore.getState().tables.get("Secret")?.rows[0].nodeId).toBe("Secret/shop/off");
});
