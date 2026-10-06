import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import type { HelmRelease, HelmReleaseDetails } from "../../shared/ipc/types";
import { HelmView } from "./HelmView";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const web: HelmRelease = { name: "web", namespace: "shop", chart: "web-1.4.2", appVersion: "2.0.1", revision: 3, status: "deployed", health: "ok", updated: "2026-10-06T09:30:00Z" };
const api: HelmRelease = { ...web, name: "api", chart: "api-0.1.0", revision: 1, status: "failed", health: "err" };
const details: HelmReleaseDetails = {
  release: web, description: "Upgrade complete", firstDeployed: "2026-10-01T08:00:00Z", lastDeployed: web.updated,
  values: "replicaCount: 2\n", notes: "Visit http://web.shop\n",
  history: [
    { revision: 3, chart: "web-1.4.2", appVersion: "2.0.1", status: "deployed", health: "ok", updated: web.updated, description: "Upgrade complete" },
    { revision: 2, chart: "web-1.4.1", appVersion: "2.0.0", status: "superseded", health: "unknown", updated: null, description: "Upgrade complete" },
  ],
  resources: ["ConfigMap/shop/web-cfg", "Deployment/shop/web"],
};

beforeEach(() => {
  useAppStore.setState({
    ...initialState(),
    connection: { ...initialState().connection, context: "prod", state: "connected", scope: ["shop"] },
    view: { name: "helm" }, helmReleases: [web, api],
  });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "helm_release" ? details : cmd === "get_object" ? { yaml: "", summary: [], related: [] } : null));
});

describe("HelmView", () => {
  it("lists releases with chart, revision and a coloured status", () => {
    render(<HelmView />);
    const grid = screen.getByRole("grid", { name: "Helm releases" });
    const failed = within(grid).getByText("failed");
    expect(failed).toHaveAttribute("data-status", "err");
    expect(within(grid).getByText("web-1.4.2")).toBeInTheDocument();
  });

  it("selects a release from the keyboard", async () => {
    render(<HelmView />);
    const row = screen.getByText("web").closest("tr")!;
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(useAppStore.getState().helmSelected).toEqual({ namespace: "shop", name: "web" }));
    fireEvent.keyDown(screen.getByText("api").closest("tr")!, { key: " " });
    await waitFor(() => expect(useAppStore.getState().helmSelected).toEqual({ namespace: "shop", name: "api" }));
  });

  it("shows an unparseable timestamp as it came", () => {
    useAppStore.setState({ helmReleases: [{ ...web, updated: "yesterday-ish" }] });
    render(<HelmView />);
    expect(screen.getByText("yesterday-ish")).toBeInTheDocument();
  });

  it("selecting a release shows its tabs and highlights its objects", async () => {
    render(<HelmView />);
    fireEvent.click(screen.getByText("web"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("helm_release", { namespace: "shop", name: "web" }));
    expect(await screen.findByText("Upgrade complete")).toBeInTheDocument();
    expect(useAppStore.getState().highlightIds).toEqual(new Set(details.resources));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Values", "History", "Notes", "Resources"]);
    fireEvent.click(screen.getByRole("tab", { name: "Values" }));
    expect(screen.getByText(/replicaCount: 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByText("superseded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByText(/Visit http:\/\/web\.shop/)).toBeInTheDocument();
  });

  it("opens a member object from Resources and clears the highlight on close", async () => {
    render(<HelmView />);
    fireEvent.click(screen.getByText("web"));
    await screen.findByText("Upgrade complete");
    fireEvent.click(screen.getByRole("tab", { name: "Resources" }));
    fireEvent.click(screen.getByRole("button", { name: /ConfigMap web-cfg/ }));
    await waitFor(() => expect(useAppStore.getState().selectedId).toBe("ConfigMap/shop/web-cfg"));
    fireEvent.click(screen.getByRole("button", { name: "Close release" }));
    expect(useAppStore.getState().highlightIds.size).toBe(0);
    expect(useAppStore.getState().helmSelected).toBeNull();
  });
});

describe("release selection in the store", () => {
  it("re-reads the open release on a list refresh and closes it once the release is gone", async () => {
    await useAppStore.getState().selectRelease("shop", "web");
    expect(useAppStore.getState().helmDetails).toEqual(details);
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "helm_releases" ? [web, api] : cmd === "helm_release" ? details : null));
    await useAppStore.getState().refreshHelm();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("helm_release", { namespace: "shop", name: "web" }));
    expect(useAppStore.getState().helmDetails).toEqual(details); // kept while re-reading
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "helm_releases" ? [api] : null));
    await useAppStore.getState().refreshHelm();
    expect(useAppStore.getState().helmSelected).toBeNull();
    expect(useAppStore.getState().highlightIds.size).toBe(0);
  });

  it("keeps the same highlight set when a refresh brings the same resources", async () => {
    await useAppStore.getState().selectRelease("shop", "web");
    const first = useAppStore.getState().highlightIds;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === "helm_release" ? { ...details, resources: [...details.resources] } : null));
    await useAppStore.getState().selectRelease("shop", "web");
    expect(useAppStore.getState().highlightIds).toBe(first);
  });

  it("drops details that land after the selection moved on", async () => {
    let resolve!: (d: HelmReleaseDetails) => void;
    vi.mocked(invoke).mockImplementation((cmd: string) => (cmd === "helm_release" ? new Promise((r) => { resolve = r as typeof resolve; }) : Promise.resolve(null)));
    const pending = useAppStore.getState().selectRelease("shop", "web");
    useAppStore.getState().clearRelease();
    resolve(details);
    await pending;
    expect(useAppStore.getState().helmDetails).toBeNull();
    expect(useAppStore.getState().highlightIds.size).toBe(0);
  });

  it("a scope switch clears the release, a refused one restores it", async () => {
    await useAppStore.getState().selectRelease("shop", "web");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => { if (cmd === "select_namespaces") throw { kind: "forbidden", message: "no" }; return null; });
    const switching = useAppStore.getState().selectScope(["blog"]);
    expect(useAppStore.getState().helmSelected).toBeNull();
    expect(useAppStore.getState().highlightIds.size).toBe(0);
    await switching;
    expect(useAppStore.getState().helmSelected).toEqual({ namespace: "shop", name: "web" });
    expect(useAppStore.getState().highlightIds).toEqual(new Set(details.resources));
    vi.mocked(invoke).mockImplementation(async () => null);
    await useAppStore.getState().selectScope(["blog"]);
    expect(useAppStore.getState().helmSelected).toBeNull();
    expect(initialState().highlightIds.size).toBe(0);
  });
});
