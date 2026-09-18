import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import type { GraphNode } from "../../shared/ipc/types";
import { settings } from "../../shared/settings";
import { Navigator } from "./Navigator";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/extra.kubeconfig") }));
vi.mock("../../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastNamespace: vi.fn(async () => null), setLastNamespace: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}) },
}));

const contexts = [
  { name: "prod", cluster: "prod-cluster", user: "u", namespace: "shop", sourceFile: "/k" },
  { name: "staging", cluster: "staging-cluster", user: "u", namespace: null, sourceFile: "/k" },
];
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: "Pod", namespace: "p", name: id.split("/").pop()!, status: "ok", badges: ["Running"], group: null, ...over,
});
const connected = () => ({ ...initialState().connection, context: "prod", state: "connected" as const, namespace: "p" });

beforeEach(() => useAppStore.setState(initialState()));

describe("Navigator clusters", () => {
  it("lists contexts, marks the connected one and connects on click", async () => {
    const connect = vi.fn(async () => true);
    const selectNamespace = vi.fn(async () => {});
    useAppStore.setState({ contexts, connection: connected(), connect, selectNamespace });
    render(<Navigator />);
    const prod = screen.getByRole("button", { name: /prod/ });
    expect(within(prod).getByTestId("status-dot")).toHaveAttribute("data-status", "connected");
    expect(within(screen.getByRole("button", { name: /staging/ })).queryByTestId("status-dot")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /staging/ }));
    expect(connect).toHaveBeenCalledWith("staging");
    await waitFor(() => expect(settings.set).toHaveBeenCalledWith("lastContext", "staging"));
  });

  it("selects the context's default namespace after connecting", async () => {
    const connect = vi.fn(async () => true);
    const selectNamespace = vi.fn(async () => {});
    useAppStore.setState({ contexts, connect, selectNamespace });
    render(<Navigator />);
    fireEvent.click(screen.getByRole("button", { name: /prod/ }));
    await waitFor(() => expect(selectNamespace).toHaveBeenCalledWith("shop"));
    expect(settings.setLastNamespace).toHaveBeenCalledWith("prod", "shop");
  });

  it("adds a kubeconfig through the file dialog", async () => {
    const addKubeconfig = vi.fn(async () => {});
    useAppStore.setState({ contexts, addKubeconfig });
    render(<Navigator />);
    fireEvent.click(screen.getByRole("button", { name: /add kubeconfig/i }));
    await waitFor(() => expect(addKubeconfig).toHaveBeenCalledWith("/tmp/extra.kubeconfig"));
  });
});

describe("Navigator tree", () => {
  it("shows sections with kind rows, counts and the worst status", () => {
    useAppStore.setState({
      ...applySnapshot(initialState(), {
        nodes: [node("Pod/p/a"), node("Pod/p/b"), node("Pod/p/c", { status: "err" }), node("Deployment/p/web", { kind: "Deployment" })],
        edges: [],
      }),
      contexts, connection: connected(),
    });
    render(<Navigator />);
    for (const label of ["Workloads", "Config", "Network", "Storage", "Access Control"]) expect(screen.getByText(label)).toBeInTheDocument();
    const pods = screen.getByRole("button", { name: /^Pods/ });
    expect(within(pods).getByText("3")).toBeInTheDocument();
    expect(within(pods).getByTestId("status-dot")).toHaveAttribute("data-status", "err");
    const deployments = screen.getByRole("button", { name: /^Deployments/ });
    expect(within(deployments).getByText("1")).toBeInTheDocument();
    expect(within(deployments).getByTestId("status-dot")).toHaveAttribute("data-status", "ok");
    expect(within(screen.getByRole("button", { name: /^Secrets/ })).queryByTestId("status-dot")).toBeNull();
  });

  it("strikes through denied kinds with an RBAC title", () => {
    useAppStore.setState({ contexts, connection: connected(), deniedKinds: new Set(["Secret"]) });
    render(<Navigator />);
    const secrets = screen.getByRole("button", { name: /^Secrets/ });
    expect(secrets).toHaveAttribute("title", "No access (RBAC)");
    expect(secrets.className).toMatch(/line-through/);
    expect(screen.getByRole("button", { name: /^Config Maps/ }).className).not.toMatch(/line-through/);
  });

  it("opens a table for a kind, the graph for Overview, and marks the active row", () => {
    const showTable = vi.fn(async () => {});
    const showGraph = vi.fn();
    useAppStore.setState({ contexts, connection: connected(), showTable, showGraph });
    const { rerender } = render(<Navigator />);
    expect(screen.getByRole("button", { name: /overview/i })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: /^Pods/ }));
    expect(showTable).toHaveBeenCalledWith("Pod");

    useAppStore.setState({ view: { name: "table", kind: "Pod" } });
    rerender(<Navigator />);
    expect(screen.getByRole("button", { name: /^Pods/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /overview/i })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("button", { name: /overview/i }));
    expect(showGraph).toHaveBeenCalled();
  });

  it("collapses a section on header click", () => {
    useAppStore.setState({ contexts, connection: connected() });
    render(<Navigator />);
    const header = screen.getByRole("button", { name: /workloads/i });
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^Pods/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Config Maps/ })).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.getByRole("button", { name: /^Pods/ })).toBeInTheDocument();
  });
});

describe("Navigator rail", () => {
  it("collapses to an icon rail and toggles back", () => {
    const toggleSidebar = vi.fn(async () => {});
    useAppStore.setState({ contexts, connection: connected(), sidebarCollapsed: true, toggleSidebar });
    render(<Navigator />);
    expect(screen.queryByText("Workloads")).toBeNull();
    expect(screen.queryByText("Pods")).toBeNull();
    expect(screen.queryByText("staging")).toBeNull();
    expect(screen.getByRole("complementary").className).toMatch(/\bw-12\b/);
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "connected");
    fireEvent.click(screen.getByRole("button", { name: /expand navigator/i }));
    expect(toggleSidebar).toHaveBeenCalled();
  });

  it("the expanded navigator has a collapse toggle", () => {
    const toggleSidebar = vi.fn(async () => {});
    useAppStore.setState({ contexts, connection: connected(), toggleSidebar });
    render(<Navigator />);
    expect(screen.getByRole("complementary").className).toMatch(/\bw-60\b/);
    fireEvent.click(screen.getByRole("button", { name: /collapse navigator/i }));
    expect(toggleSidebar).toHaveBeenCalled();
  });
});
