import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot, initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import type { GraphNode } from "../../shared/ipc/types";
import { useUpdateStore } from "../update/updateStore";
import { Navigator } from "./Navigator";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/extra.kubeconfig") }));
vi.mock("../../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
}));

const contexts = [
  { name: "prod", cluster: "prod-cluster", user: "u", namespace: "shop", sourceFile: "/k" },
  { name: "staging", cluster: "staging-cluster", user: "u", namespace: null, sourceFile: "/k" },
];
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: "Pod", namespace: "p", name: id.split("/").pop()!, status: "ok", badges: ["Running"], group: null, ...over,
});
const connected = () => ({ ...initialState().connection, context: "prod", state: "connected" as const, scope: ["p"] });

beforeEach(() => useAppStore.setState(initialState()));

describe("Navigator tree", () => {
  it("has no cluster section: the header's menu holds the clusters", () => {
    useAppStore.setState({ contexts, connection: connected() });
    render(<Navigator />);
    expect(screen.queryByText("Clusters")).toBeNull();
    expect(screen.queryByRole("button", { name: /add kubeconfig/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /staging/ })).toBeNull();
  });

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
    expect(screen.getByRole("complementary").className).toMatch(/\bw-64\b/);
    fireEvent.click(screen.getByRole("button", { name: /collapse navigator/i }));
    expect(toggleSidebar).toHaveBeenCalled();
  });

  it("shows the app version in the footer, taken from the bundle", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "app_version" ? "9.9.9" : null) as never);
    useAppStore.setState({ contexts, connection: connected() });
    render(<Navigator />);
    expect(await screen.findByText("Version 9.9.9")).toBeInTheDocument();
    // The collapsed rail is 48 px wide: the version does not fit there.
    useAppStore.setState({ sidebarCollapsed: true });
    render(<Navigator />);
    expect(screen.queryByText("Version 9.9.9")).toBeNull();
  });

  it("carries the brand: the wordmark expanded, the mark alone in the rail", () => {
    useAppStore.setState({ contexts, connection: connected() });
    const { unmount } = render(<Navigator />);
    expect(screen.getByText("Wiring")).toBeInTheDocument();
    expect(screen.getByTestId("brand-mark")).toBeInTheDocument();
    unmount();
    useAppStore.setState({ sidebarCollapsed: true });
    render(<Navigator />);
    expect(screen.queryByText("Wiring")).toBeNull();
    expect(screen.getByTestId("brand-mark")).toBeInTheDocument();
  });

  it("checks for updates from the footer's button, next to the version", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "app_version" ? "9.9.9" : null) as never);
    const check = vi.fn(async () => {});
    useUpdateStore.setState({ check });
    useAppStore.setState({ contexts, connection: connected() });
    render(<Navigator />);
    fireEvent.click(await screen.findByRole("button", { name: /check for updates/i }));
    expect(check).toHaveBeenCalledWith(true);
  });

describe("Navigator across namespaces", () => {
  it("counts from the too-large summary and marks partially readable kinds", () => {
    useAppStore.setState({
      ...initialState(), contexts, connection: connected(),
      tooLarge: { nodes: 1873, kinds: [{ kind: "Pod", count: 1500, worst: "err" }] },
      partialKinds: new Set(["Secret"]),
    });
    render(<Navigator />);
    const pods = screen.getByRole("button", { name: /^Pods/ });
    expect(within(pods).getByText("1500")).toBeInTheDocument();
    expect(within(pods).getByTestId("status-dot")).toHaveAttribute("data-status", "err");
    const secrets = screen.getByRole("button", { name: /^Secrets/ });
    expect(within(secrets).getByText("partial")).toHaveAttribute("title", "Some namespaces are not readable (RBAC)");
    expect(within(pods).queryByText("partial")).toBeNull();
  });
});
});
