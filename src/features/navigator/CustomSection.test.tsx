import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import type { CustomKind } from "../../shared/ipc/types";
import { CustomSection } from "./CustomSection";
import { HelmSection } from "./HelmSection";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const cert: CustomKind = { resource: { group: "cert-manager.io", version: "v1", kind: "Certificate", plural: "certificates", namespaced: true }, columns: [] };
const issuer: CustomKind = { resource: { ...cert.resource, kind: "ClusterIssuer", plural: "clusterissuers", namespaced: false }, columns: [] };
const rollout: CustomKind = { resource: { group: "argoproj.io", version: "v1alpha1", kind: "Rollout", plural: "rollouts", namespaced: true }, columns: [] };
const connected = () => ({ ...initialState().connection, context: "prod", state: "connected" as const, scope: ["shop"] });
const table = { kind: "Custom" as const, columns: [{ key: "name", label: "Name", numeric: false }], rows: [{ nodeId: "Custom/cert-manager.io/v1/Certificate/shop/a", status: "ok" as const, cells: [{ text: "a", status: null }] }] };

beforeEach(() => {
  useAppStore.setState(initialState());
  vi.mocked(invoke).mockReset();
});

describe("Custom Resources section", () => {
  it("loads the kinds once connected and groups them by API group", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "custom_kinds" ? [rollout, cert, issuer] : null));
    useAppStore.setState({ connection: connected() });
    render(<CustomSection />);
    expect(await screen.findByRole("button", { name: /argoproj\.io/ })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("custom_kinds", undefined);
    expect(screen.queryByRole("button", { name: "Certificate" })).toBeNull(); // groups start collapsed
    fireEvent.click(screen.getByRole("button", { name: /cert-manager\.io/ }));
    expect(screen.getByRole("button", { name: "Certificate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ClusterIssuer" })).toBeInTheDocument();
  });

  it("opens a kind's table and shows its count once opened", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "list_custom" ? { resource: cert.resource, table, error: null } : null));
    useAppStore.setState({ connection: connected(), customKinds: [cert] });
    render(<CustomSection />);
    fireEvent.click(screen.getByRole("button", { name: /cert-manager\.io/ }));
    fireEvent.click(screen.getByRole("button", { name: "Certificate" }));
    await waitFor(() => expect(useAppStore.getState().view).toEqual({ name: "custom", resource: cert.resource }));
    expect(invoke).toHaveBeenCalledWith("list_custom", { resource: cert.resource });
    expect(await screen.findByRole("button", { name: "Certificate 1" })).toHaveAttribute("aria-current", "page");
  });

  it("says when discovery failed and refreshes on request", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "custom_kinds") throw { kind: "forbidden", message: "nope" };
      return cmd === "refresh_custom_kinds" ? [] : null;
    });
    useAppStore.setState({ connection: connected() });
    render(<CustomSection />);
    expect(await screen.findByText("Custom resources unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh custom resources" }));
    expect(await screen.findByText("No custom resources")).toBeInTheDocument();
  });

  it("stops the custom watch when another view replaces the table", async () => {
    useAppStore.setState({ connection: connected(), view: { name: "custom", resource: cert.resource } });
    useAppStore.getState().showGraph();
    expect(invoke).toHaveBeenCalledWith("stop_custom", undefined);
  });
});

describe("custom kinds store", () => {
  it("keeps a table's terminal error until a later listing clears it", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "list_custom" ? { resource: cert.resource, table, error: null } : null));
    useAppStore.setState({ connection: connected(), customKinds: [cert], view: { name: "custom", resource: cert.resource } });
    useAppStore.getState().applyCustomTable({ resource: cert.resource, table: { ...table, rows: [] }, error: "forbidden" });
    expect(useAppStore.getState().customTableErrors.get("cert-manager.io/v1/Certificate")).toBe("forbidden");
    expect(useAppStore.getState().customTables.get("cert-manager.io/v1/Certificate")?.rows).toEqual([]);
    await useAppStore.getState().refreshCustom(cert.resource);
    expect(useAppStore.getState().customTableErrors.has("cert-manager.io/v1/Certificate")).toBe(false);
    expect(useAppStore.getState().customTables.get("cert-manager.io/v1/Certificate")?.rows).toHaveLength(1);
  });

  it("forgets the kinds, tables and releases of the previous cluster on connect", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "connect" ? { context: "dev", serverVersion: "1.30", namespaces: ["default"], canListNamespaces: true } : null);
    useAppStore.setState({
      connection: connected(), customKinds: [cert], customKindsError: { kind: "forbidden", message: "x" },
      customTables: new Map([["cert-manager.io/v1/Certificate", table]]), customTableErrors: new Map([["cert-manager.io/v1/Certificate", "gone"]]),
      helmReleases: [], view: { name: "custom", resource: cert.resource },
    });
    await useAppStore.getState().connect("dev");
    const s = useAppStore.getState();
    expect(s.customKinds).toBeNull();
    expect(s.customKindsError).toBeNull();
    expect(s.customTables.size).toBe(0);
    expect(s.customTableErrors.size).toBe(0);
    expect(s.helmReleases).toBeNull();
    expect(s.view).toEqual({ name: "graph" });
  });

  it("a load for a previous cluster does not end the loading of the next one", async () => {
    const pending: Array<(v: CustomKind[]) => void> = [];
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      cmd === "custom_kinds" ? new Promise((r) => pending.push(r as (v: CustomKind[]) => void)) : Promise.resolve(null));
    useAppStore.setState({ connection: connected() });
    void useAppStore.getState().loadCustomKinds();
    useAppStore.setState({ ...initialState(), connection: { ...connected(), context: "dev" } });
    const second = useAppStore.getState().loadCustomKinds();
    pending[0]([cert]);
    await Promise.resolve(); await Promise.resolve();
    expect(useAppStore.getState().customKindsLoading).toBe(true);
    expect(useAppStore.getState().customKinds).toBeNull();
    pending[1]([rollout]);
    await second;
    expect(useAppStore.getState().customKinds).toEqual([rollout]);
    expect(useAppStore.getState().customKindsLoading).toBe(false);
  });
});

describe("Helm section", () => {
  it("opens the releases view with its count", async () => {
    const release = { name: "web", namespace: "shop", chart: "web-1.0.0", appVersion: "1", revision: 1, status: "deployed", health: "ok", updated: null };
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "helm_releases" ? [release] : null));
    useAppStore.setState({ connection: connected(), graphReady: true });
    render(<HelmSection />);
    const row = await screen.findByRole("button", { name: "Releases 1" });
    fireEvent.click(row);
    expect(useAppStore.getState().view).toEqual({ name: "helm" });
  });
});
