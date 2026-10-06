import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { ContextPicker } from "./ContextPicker";
import { Header } from "./Header";
import { NamespacePicker } from "./NamespacePicker";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/extra.kubeconfig") }));
vi.mock("../../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
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
  });
});

describe("NamespacePicker", () => {
  const open = (selectScope = vi.fn(async () => {}), extra: Record<string, unknown> = {}) => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: ["blog", "payments", "shop"], scope: ["shop"], ...extra }, selectScope });
    render(<NamespacePicker />);
    fireEvent.click(screen.getByRole("button", { name: "Namespace" }));
    return selectScope;
  };

  it("shows the scope and picks one namespace by name", () => {
    const selectScope = open();
    fireEvent.click(screen.getByRole("button", { name: "payments" }));
    expect(selectScope).toHaveBeenCalledWith(["payments"]);
    expect(screen.queryByRole("dialog", { name: "Namespaces" })).toBeNull();
  });

  it("applies several ticked namespaces", () => {
    const selectScope = open();
    fireEvent.click(screen.getByLabelText("Include blog"));
    fireEvent.click(screen.getByRole("button", { name: "Apply (2)" }));
    expect(selectScope).toHaveBeenCalledWith(["blog", "shop"]);
  });

  it("selects all namespaces", () => {
    const selectScope = open();
    fireEvent.click(screen.getByRole("button", { name: /All namespaces \(3\)/ }));
    expect(selectScope).toHaveBeenCalledWith("all");
  });

  it("without namespace listing shows the known rows, no All row, and a free-text field", () => {
    const selectScope = open(vi.fn(async () => {}), { namespaces: ["shop"], canListNamespaces: false });
    expect(screen.queryByRole("button", { name: /All namespaces/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "shop" }));
    expect(selectScope).toHaveBeenCalledWith(["shop"]);
    fireEvent.click(screen.getByRole("button", { name: "Namespace" }));
    const input = screen.getByLabelText("Add a namespace");
    fireEvent.change(input, { target: { value: "team-a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selectScope).toHaveBeenLastCalledWith(["team-a"]);
  });

  it("filters the list", () => {
    open();
    fireEvent.change(screen.getByLabelText("Filter namespaces"), { target: { value: "pay" } });
    expect(screen.queryByRole("button", { name: "blog" })).toBeNull();
    expect(screen.getByRole("button", { name: "payments" })).toBeTruthy();
  });

  it("labels the button with a truncated list", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: ["a", "b", "c", "d", "e"], scope: ["a", "b", "c", "d", "e"] } });
    render(<NamespacePicker />);
    expect(screen.getByRole("button", { name: "Namespace" })).toHaveTextContent("a, b +3");
  });

  it("stops ticking at 20 and says why", () => {
    const many = Array.from({ length: 22 }, (_, i) => `ns-${String(i).padStart(2, "0")}`);
    open(vi.fn(async () => {}), { namespaces: many, scope: [] });
    for (const ns of many.slice(0, 20)) fireEvent.click(screen.getByLabelText(`Include ${ns}`));
    expect(screen.getByLabelText("Include ns-20")).toBeDisabled();
    expect(screen.getByLabelText("Include ns-00")).not.toBeDisabled();
    expect(screen.getByText("Up to 20 \u2014 or pick All namespaces")).toBeTruthy();
  });

  it("Space ticks, arrows move, Enter applies", () => {
    const selectScope = open();
    const filter = screen.getByLabelText("Filter namespaces");
    fireEvent.keyDown(filter, { key: "ArrowDown" }); // All
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Namespaces" }), { key: "ArrowDown" }); // blog
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Namespaces" }), { key: " " });
    expect(screen.getByLabelText("Include blog")).toBeChecked();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Namespaces" }), { key: "Enter" });
    expect(selectScope).toHaveBeenCalledWith(["blog", "shop"]);
  });

  it("Escape closes it without reaching the global handler", () => {
    open();
    const global = vi.fn();
    const onKey = (e: KeyboardEvent) => { if (!e.defaultPrevented) global(); };
    window.addEventListener("keydown", onKey);
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", onKey);
    expect(screen.queryByRole("dialog", { name: "Namespaces" })).toBeNull();
    expect(global).not.toHaveBeenCalled();
  });

  it("falls back to a text input when the namespace list is empty or not listable", () => {
    const selectScope = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: [], scope: null }, selectScope });
    render(<NamespacePicker />);
    const input = screen.getByLabelText("Namespace");
    fireEvent.change(input, { target: { value: "team-a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selectScope).toHaveBeenCalledWith(["team-a"]);
  });

  it("rejects a name that is not a DNS label", () => {
    const selectScope = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", namespaces: [], scope: null }, selectScope });
    render(<NamespacePicker />);
    const input = screen.getByLabelText("Namespace");
    fireEvent.change(input, { target: { value: "Bad_Name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(selectScope).not.toHaveBeenCalled();
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
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", scope: null }, openCreate });
    const { unmount } = render(<Header />);
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();
    unmount();

    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", scope: ["shop"] }, openCreate });
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
