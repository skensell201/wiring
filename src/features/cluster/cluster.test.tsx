import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { settings } from "../../shared/settings";
import { ContextPicker } from "./ContextPicker";
import { Header } from "./Header";
import { NamespacePicker } from "./NamespacePicker";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/extra.kubeconfig") }));
vi.mock("../../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastNamespace: vi.fn(async () => null), setLastNamespace: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}) },
}));

beforeEach(() => useAppStore.setState(initialState()));

describe("ContextPicker", () => {
  it("lists contexts and connects on click", async () => {
    const connect = vi.fn(async () => true);
    useAppStore.setState({ contexts: [{ name: "prod", cluster: "c", user: "u", namespace: null, sourceFile: "/k" }], connect, pickerOpen: true });
    render(<ContextPicker />);
    fireEvent.click(screen.getByRole("button", { name: /prod/ }));
    expect(connect).toHaveBeenCalledWith("prod");
  });

  it("is a modal dialog named by its heading", () => {
    useAppStore.setState({ contexts: [], pickerOpen: true });
    render(<ContextPicker />);
    const dialog = screen.getByRole("dialog", { name: /choose a cluster/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("Escape and Cancel close it whenever there are contexts to fall back to, and are absent otherwise", () => {
    // With no contexts the picker is the only way forward (add a kubeconfig), so it cannot be dismissed.
    useAppStore.setState({ contexts: [], pickerOpen: true });
    const { unmount } = render(<ContextPicker />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().pickerOpen).toBe(true);
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    unmount();

    // With contexts the Navigator lists them, so the modal is optional even when nothing is connected.
    const contexts = [{ name: "prod", cluster: "c", user: "u", namespace: null, sourceFile: "/k" }];
    useAppStore.setState({ contexts, pickerOpen: true, connection: initialState().connection });
    const second = render(<ContextPicker />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().pickerOpen).toBe(false);
    second.unmount();

    useAppStore.setState({ contexts, pickerOpen: true, connection: initialState().connection });
    render(<ContextPicker />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(useAppStore.getState().pickerOpen).toBe(false);
  });

  it("shows instructions when there are no contexts", () => {
    useAppStore.setState({ contexts: [], pickerOpen: true });
    render(<ContextPicker />);
    expect(screen.getByText(/no kubeconfig contexts found/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add kubeconfig/i })).toBeInTheDocument();
  });

  it("opens the context's default namespace after connecting", async () => {
    const connect = vi.fn(async () => true);
    const selectNamespace = vi.fn(async () => {});
    useAppStore.setState({
      contexts: [{ name: "prod", cluster: "c", user: "u", namespace: "shop", sourceFile: "/k" }],
      connect,
      selectNamespace,
      pickerOpen: true,
    });
    render(<ContextPicker />);
    fireEvent.click(screen.getByRole("button", { name: /prod/ }));
    await waitFor(() => expect(selectNamespace).toHaveBeenCalledWith("shop"));
    expect(settings.setLastNamespace).toHaveBeenCalledWith("prod", "shop");
  });
});

describe("NamespacePicker", () => {
  it("lists namespaces, selects one and remembers it for the context", () => {
    const selectNamespace = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: ["default", "payments"] }, selectNamespace });
    render(<NamespacePicker />);
    fireEvent.change(screen.getByLabelText("Namespace"), { target: { value: "payments" } });
    expect(selectNamespace).toHaveBeenCalledWith("payments");
    expect(settings.setLastNamespace).toHaveBeenCalledWith("prod", "payments");
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
    const reconnect = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "degraded", serverVersion: "v1.33.0" }, reconnect });
    render(<Header />);
    expect(screen.getByTestId("status-dot")).toHaveAttribute("data-status", "degraded");
    expect(screen.getByText("prod")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    expect(reconnect).toHaveBeenCalled();
  });

  it("the context button toggles the navigator when contexts exist, and opens the picker otherwise", () => {
    const toggleSidebar = vi.fn(async () => {});
    useAppStore.setState({ contexts: [], connection: { ...initialState().connection }, toggleSidebar });
    const { unmount } = render(<Header />);
    fireEvent.click(screen.getByRole("button", { name: /choose cluster/i }));
    expect(useAppStore.getState().pickerOpen).toBe(true);
    expect(toggleSidebar).not.toHaveBeenCalled();
    unmount();

    useAppStore.setState({
      contexts: [{ name: "prod", cluster: "c", user: "u", namespace: null, sourceFile: "/k" }],
      connection: { ...initialState().connection, context: "prod", state: "connected" }, pickerOpen: false, toggleSidebar,
    });
    render(<Header />);
    fireEvent.click(screen.getByRole("button", { name: /prod/ }));
    expect(toggleSidebar).toHaveBeenCalled();
    expect(useAppStore.getState().pickerOpen).toBe(false);
  });

  it("+ Create opens the create dialog, and is disabled until a namespace is selected", () => {
    const openCreate = vi.fn();
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespace: null }, openCreate });
    const { unmount } = render(<Header />);
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
    unmount();

    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespace: "shop" }, openCreate });
    render(<Header />);
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(openCreate).toHaveBeenCalled();
  });

  it("has no Create button before a cluster is connected", () => {
    useAppStore.setState({ connection: initialState().connection });
    render(<Header />);
    expect(screen.queryByRole("button", { name: /create/i })).not.toBeInTheDocument();
  });

  it("search box updates the store", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod" } });
    render(<Header />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "web" } });
    expect(useAppStore.getState().search).toBe("web");
  });
});
