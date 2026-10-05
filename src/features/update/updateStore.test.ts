import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}), Channel: class {} }));

import { initialState, useAppStore } from "../../app/store";
import { invoke } from "../../shared/ipc/tauri";
import { initialUpdateState, useUpdateStore } from "./updateStore";

const offer = { version: "0.3.0", date: "2026-10-05", notes: "New" };

beforeEach(() => {
  useAppStore.setState(initialState());
  useUpdateStore.setState(initialUpdateState());
  vi.mocked(invoke).mockReset();
});

describe("update store", () => {
  it("a background check stores the offer without opening the dialog", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ current: "0.2.0", update: offer });
    await useUpdateStore.getState().check(false);
    expect(useUpdateStore.getState()).toMatchObject({ available: offer, current: "0.2.0", dialogOpen: false });
  });

  it("a background check failure is silent", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "network", message: "offline" });
    await useUpdateStore.getState().check(false);
    expect(useAppStore.getState().toasts).toHaveLength(0);
  });

  it("a manual check opens the dialog for an offer, toasts up-to-date, and toasts errors", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ current: "0.2.0", update: offer });
    await useUpdateStore.getState().check(true);
    expect(useUpdateStore.getState().dialogOpen).toBe(true);

    useUpdateStore.setState(initialUpdateState());
    vi.mocked(invoke).mockResolvedValueOnce({ current: "0.2.0", update: null });
    await useUpdateStore.getState().check(true);
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "info", message: "Wiring 0.2.0 is up to date" });

    vi.mocked(invoke).mockRejectedValueOnce({ kind: "network", message: "offline" });
    await useUpdateStore.getState().check(true);
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ kind: "network", message: "offline" });
  });

  it("Later hides the pill until the next launch, but not while installing", () => {
    useUpdateStore.setState({ available: offer, dialogOpen: true });
    useUpdateStore.getState().later();
    expect(useUpdateStore.getState()).toMatchObject({ dialogOpen: false, dismissed: true });

    useUpdateStore.setState({ dialogOpen: true, installing: true });
    useUpdateStore.getState().later();
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
  });

  it("a failed install shows the error and allows a retry", async () => {
    useUpdateStore.setState({ available: offer, dialogOpen: true });
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "internal", message: "signature mismatch" });
    await useUpdateStore.getState().install();
    expect(useUpdateStore.getState()).toMatchObject({ installing: false, error: "signature mismatch" });
    expect(invoke).toHaveBeenCalledWith("install_update", undefined);
  });

  it("ignores a second install while one runs", async () => {
    useUpdateStore.setState({ installing: true });
    await useUpdateStore.getState().install();
    expect(invoke).not.toHaveBeenCalled();
  });
});
