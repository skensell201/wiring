import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}), Channel: class {} }));

import { invoke } from "../../shared/ipc/tauri";
import { initialState, useAppStore } from "../../app/store";
import { useGlobalKeys } from "../../app/useGlobalKeys";
import { UpdateDialog } from "./UpdateDialog";
import { UpdatePill } from "./UpdatePill";
import { initialUpdateState, useUpdateStore } from "./updateStore";

const offer = { version: "0.3.0", date: "2026-10-05", notes: "Port-forward and metrics." };

beforeEach(() => { useUpdateStore.setState(initialUpdateState()); vi.mocked(invoke).mockReset(); });

describe("UpdatePill", () => {
  it("is hidden without an offer or after Later, and opens the dialog", () => {
    const { rerender } = render(<UpdatePill />);
    expect(screen.queryByRole("button", { name: /Update/ })).toBeNull();
    useUpdateStore.setState({ available: offer });
    rerender(<UpdatePill />);
    fireEvent.click(screen.getByRole("button", { name: "Update 0.3.0" }));
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
    useUpdateStore.setState({ dismissed: true });
    rerender(<UpdatePill />);
    expect(screen.queryByRole("button", { name: /Update/ })).toBeNull();
  });
});

describe("UpdateDialog", () => {
  const open = (extra = {}) => useUpdateStore.setState({ available: offer, current: "0.2.0", dialogOpen: true, ...extra });

  it("shows the version, date and notes, and Later closes it", () => {
    open();
    render(<UpdateDialog />);
    expect(screen.getByRole("dialog", { name: "Wiring 0.3.0 is available" })).toBeTruthy();
    expect(screen.getByText("You have 0.2.0 · released 2026-10-05")).toBeTruthy();
    expect(screen.getByText("Port-forward and metrics.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(useUpdateStore.getState()).toMatchObject({ dialogOpen: false, dismissed: true });
  });

  it("Escape is Later, and is handled before the global keys", () => {
    open();
    render(<UpdateDialog />);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it("Escape does not also act on the selection underneath", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ ...initialState(), selectedId: "Pod/p/a", select });
    open();
    function Harness() { useGlobalKeys(); return <UpdateDialog />; }
    render(<Harness />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it("installs with a progress bar", () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {})); // relaunch: never resolves
    open();
    render(<UpdateDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(screen.getByText("Starting download…")).toBeTruthy();
    act(() => useUpdateStore.getState().setProgress({ downloaded: 12.3 * 1024 * 1024, total: 45.6 * 1024 * 1024 }));
    expect(screen.getByText("12.3 / 45.6 MB")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("27");
    expect(screen.getByRole("button", { name: "Later" })).toHaveProperty("disabled", true);
  });

  it("shows an install error with Retry", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "internal", message: "signature mismatch" });
    open();
    render(<UpdateDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "signature mismatch");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
