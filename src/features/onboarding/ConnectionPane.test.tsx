import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import type { AppError, KubeconfigSource } from "../../shared/ipc/types";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/tmp/team.yaml") }));
vi.mock("../../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
}));

import { invoke } from "../../shared/ipc/tauri";
import { ConnectionPane } from "./ConnectionPane";
import { connectionPane } from "./panes";

const SOURCES: KubeconfigSource[] = [
  { path: "/Users/me/.kube/config", origin: "default", state: "missing", contexts: 0, error: null },
  { path: "/Users/me/broken.yaml", origin: "added", state: "invalid", contexts: 0, error: "did not find expected key" },
];
const INFO = { context: "gke-prod", serverVersion: "v1.33.0", namespaces: ["shop"], canListNamespaces: true };
const HELPER: AppError = { kind: "auth", message: "unable to run auth exec: No such file or directory (os error 2) (exec plugin: gke-gcloud-auth-plugin)" };
const called = () => vi.mocked(invoke).mock.calls.map((c) => c[0]);

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "kubeconfig_sources") return SOURCES;
    if (cmd === "list_contexts" || cmd === "add_kubeconfig") return [];
    if (cmd === "connect") return INFO;
    if (cmd === "denied_kinds" || cmd === "partial_kinds") return [];
    return null;
  });
});

describe("connectionPane", () => {
  const c = initialState().connection;
  it("picks the pane in priority order", () => {
    const error = { context: "a", error: HELPER };
    expect(connectionPane({ ...c, connecting: "b", context: "a", lastError: error }, 2)).toEqual({ type: "connecting", context: "b" });
    expect(connectionPane({ ...c, context: "a" }, 2)).toBeNull();
    expect(connectionPane({ ...c, lastError: error }, 2)).toEqual({ type: "failed", context: "a", error: HELPER });
    expect(connectionPane(c, 0)).toEqual({ type: "welcome" });
    expect(connectionPane(c, 3)).toEqual({ type: "choose", contexts: 3 });
  });
});

describe("welcome pane", () => {
  it("lists every kubeconfig location Wiring read, with what it found", async () => {
    render(<ConnectionPane pane={{ type: "welcome" }} />);
    expect(screen.getByRole("status", { name: "Connect Wiring to a cluster" })).toBeInTheDocument();
    expect(await screen.findByText("/Users/me/.kube/config")).toBeInTheDocument();
    expect(screen.getByText("default location · not found")).toBeInTheDocument();
    expect(screen.getByText("added in Wiring · can't be read: did not find expected key")).toBeInTheDocument();
    expect(screen.getByText("Kubeconfig files Wiring checked:")).toBeInTheDocument();
  });

  it("Add kubeconfig… and Rescan call the backend", async () => {
    useAppStore.setState({ kubeconfigSources: SOURCES });
    render(<ConnectionPane pane={{ type: "welcome" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add kubeconfig…" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("add_kubeconfig", { path: "/tmp/team.yaml" }));
    vi.mocked(invoke).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(called()).toEqual(expect.arrayContaining(["list_contexts", "kubeconfig_sources"])));
  });
});

describe("other panes", () => {
  it("points to the navigator when there are contexts but no connection", () => {
    render(<ConnectionPane pane={{ type: "choose", contexts: 2 }} />);
    expect(screen.getByRole("status", { name: "Choose a cluster" })).toHaveTextContent("Pick one of your 2 kubeconfig contexts in the navigator.");
  });

  it("says which context it is connecting to", () => {
    render(<ConnectionPane pane={{ type: "connecting", context: "prod" }} />);
    expect(screen.getByRole("status", { name: "Connecting to prod…" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("failure pane", () => {
  const fail = () => useAppStore.setState({
    contexts: [{ name: "gke-prod", cluster: "c", user: "u", namespace: "shop", sourceFile: "/k" }],
    connection: { ...initialState().connection, lastError: { context: "gke-prod", error: HELPER } },
  });

  it("shows the cause, the server's message and the hint; Retry reconnects", async () => {
    fail();
    render(<ConnectionPane pane={{ type: "failed", context: "gke-prod", error: HELPER }} />);
    const region = screen.getByRole("alert", { name: "The gke-gcloud-auth-plugin login helper isn't installed" });
    expect(region).toHaveTextContent("unable to run auth exec");
    expect(region).toHaveTextContent("gcloud components install gke-gcloud-auth-plugin");
    expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("connect", { context: "gke-prod" }));
    await waitFor(() => expect(useAppStore.getState().connection.context).toBe("gke-prod"));
  });

  it("Choose another cluster leaves the failure behind", async () => {
    fail();
    render(<ConnectionPane pane={{ type: "failed", context: "gke-prod", error: HELPER }} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose another cluster" }));
    await waitFor(() => expect(useAppStore.getState().connection.lastError).toBeNull());
  });
});
