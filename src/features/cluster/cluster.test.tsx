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
