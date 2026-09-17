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
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastNamespace: vi.fn(async () => null), setLastNamespace: vi.fn(async () => {}) },
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

  it("Escape closes it when a context is already connected, and is ignored otherwise", () => {
    useAppStore.setState({ contexts: [], pickerOpen: true });
    const { unmount } = render(<ContextPicker />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().pickerOpen).toBe(true);
    unmount();

    useAppStore.setState({ contexts: [], pickerOpen: true, connection: { ...initialState().connection, context: "prod", state: "connected" } });
    render(<ContextPicker />);
    fireEvent.keyDown(window, { key: "Escape" });
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

  it("search box updates the store", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod" } });
    render(<Header />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "web" } });
    expect(useAppStore.getState().search).toBe("web");
  });
});
