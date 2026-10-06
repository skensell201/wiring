import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { initialState, useAppStore } from "./store";

vi.mock("../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));
vi.mock("../shared/settings", () => ({
  settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}), getLastScope: vi.fn(async () => null), setLastScope: vi.fn(async () => {}), getSidebarCollapsed: vi.fn(async () => false), setSidebarCollapsed: vi.fn(async () => {}), getDetailsHeight: vi.fn(async () => null), setDetailsHeight: vi.fn(async () => {}) },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("./startup", () => ({ startup: vi.fn(async () => {}) }));

beforeEach(() => useAppStore.setState(initialState()));

describe("global keys", () => {
  it("Escape clears the selection and blurs the focused element", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" }, selectedId: "Pod/p/a", select });
    render(<App />);
    const search = screen.getByPlaceholderText(/search/i);
    search.focus();
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(select).toHaveBeenCalledWith(null);
    expect(document.activeElement).toBe(document.body);
  });

  it("Escape does not touch the selection while the context picker is open", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" }, selectedId: "Pod/p/a", select, pickerOpen: true });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(select).not.toHaveBeenCalled();
  });

  it("Escape restores a maximised details panel before touching the selection", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" }, selectedId: "Pod/p/a", select, detailsMaximized: true });
    render(<App />);
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().detailsMaximized).toBe(false);
    expect(useAppStore.getState().selectedId).toBe("Pod/p/a");
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole("main")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(select).toHaveBeenCalledWith(null);
  });

  it("Cmd/Ctrl+K focuses the search box", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" } });
    render(<App />);
    fireEvent.keyDown(window, { key: "k", metaKey: true, ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/search/i));
  });
});

describe("editing keys", () => {
  const connected = () => ({ connection: { ...initialState().connection, context: "prod", state: "connected" as const } });
  const editing = (mode: "view" | "edit" | "review", saving = false) => ({
    selectedId: "Pod/p/a",
    details: { nodeId: "Pod/p/a", data: { yaml: "kind: Pod\n", summary: [], related: [] }, events: [], loading: false, editor: { mode, buffer: "kind: Pod\nx: 1\n", original: "kind: Pod\n", error: null, saving } },
  });
  const cmdS = () => new KeyboardEvent("keydown", { key: "s", metaKey: true, ctrlKey: true, cancelable: true, bubbles: true });

  it("Cmd/Ctrl+S reviews the edit in edit mode and is otherwise left to the browser", () => {
    const reviewEdit = vi.fn();
    useAppStore.setState({ ...connected(), ...editing("edit"), reviewEdit });
    render(<App />);
    const ev = new KeyboardEvent("keydown", { key: "s", metaKey: true, ctrlKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(ev);
    expect(reviewEdit).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);

    useAppStore.setState(editing("view"));
    const plain = cmdS();
    window.dispatchEvent(plain);
    expect(reviewEdit).toHaveBeenCalledTimes(1);
    expect(plain.defaultPrevented).toBe(false);
  });

  it("Cmd/Ctrl+S is ignored under the picker or a dialog, and with Shift held", () => {
    const reviewEdit = vi.fn();
    const { discardDialog, deleteDialog, createDialog } = initialState();
    useAppStore.setState({ ...connected(), ...editing("edit"), reviewEdit });
    render(<App />);
    const layers = [
      { pickerOpen: true },
      { discardDialog: { ...discardDialog, open: true } },
      { deleteDialog: { open: true, nodeId: "Pod/p/a" } },
      { createDialog: { ...createDialog, open: true } },
    ];
    for (const layer of layers) {
      useAppStore.setState({ pickerOpen: false, discardDialog, deleteDialog, createDialog, ...layer });
      const ev = cmdS();
      window.dispatchEvent(ev);
      expect(reviewEdit).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    }
    useAppStore.setState({ pickerOpen: false, discardDialog, deleteDialog, createDialog });
    const shifted = new KeyboardEvent("keydown", { key: "S", metaKey: true, ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(shifted);
    expect(reviewEdit).not.toHaveBeenCalled();
    expect(shifted.defaultPrevented).toBe(false);
  });

  it("Escape in review goes back to edit; in edit it cancels; the selection is untouched", () => {
    const backToEdit = vi.fn();
    const cancelEdit = vi.fn();
    const select = vi.fn(async () => {});
    useAppStore.setState({ ...connected(), ...editing("review"), backToEdit, cancelEdit, select });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(backToEdit).toHaveBeenCalledTimes(1);
    expect(cancelEdit).not.toHaveBeenCalled();
    useAppStore.setState(editing("edit"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancelEdit).toHaveBeenCalledTimes(1);
    expect(backToEdit).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("Escape closes an open dialog (which owns the key) and leaves the editor under it alone", () => {
    // Only one dialog is ever open at a time; each sits on top of an editing session.
    const cancelDiscard = vi.fn();
    const cancelDelete = vi.fn();
    const closeCreate = vi.fn();
    const cancelEdit = vi.fn();
    const { discardDialog, deleteDialog, createDialog } = initialState();
    const base = { ...connected(), ...editing("edit"), cancelDiscard, cancelDelete, closeCreate, cancelEdit, discardDialog, deleteDialog, createDialog };
    useAppStore.setState({ ...base, discardDialog: { ...discardDialog, open: true } });
    const { unmount } = render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancelDiscard).toHaveBeenCalledTimes(1);
    unmount();

    useAppStore.setState({ ...base, deleteDialog: { open: true, nodeId: "Pod/p/a" } });
    const second = render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancelDelete).toHaveBeenCalledTimes(1);
    second.unmount();

    useAppStore.setState({ ...base, createDialog: { ...createDialog, open: true } });
    const third = render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeCreate).toHaveBeenCalledTimes(1);
    expect(cancelEdit).not.toHaveBeenCalled();
    third.unmount();

    useAppStore.setState(base);
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancelEdit).toHaveBeenCalledTimes(1);
  });

  it("Escape restores a maximised panel after the dialogs and before the editor", () => {
    const cancelDiscard = vi.fn();
    const backToEdit = vi.fn();
    const { discardDialog } = initialState();
    useAppStore.setState({ ...connected(), ...editing("review"), cancelDiscard, backToEdit, detailsMaximized: true, discardDialog: { ...discardDialog, open: true } });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancelDiscard).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().detailsMaximized).toBe(true);
    expect(backToEdit).not.toHaveBeenCalled();
    useAppStore.setState({ discardDialog });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().detailsMaximized).toBe(false);
    expect(backToEdit).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(backToEdit).toHaveBeenCalledTimes(1);
  });

  it("Escape is ignored while saving", () => {
    const backToEdit = vi.fn();
    const cancelEdit = vi.fn();
    const select = vi.fn(async () => {});
    useAppStore.setState({ ...connected(), ...editing("review", true), backToEdit, cancelEdit, select });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    useAppStore.setState(editing("edit", true));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(backToEdit).not.toHaveBeenCalled();
    expect(cancelEdit).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("Escape marked handled by a widget is ignored", () => {
    const cancelEdit = vi.fn();
    useAppStore.setState({ ...connected(), ...editing("edit"), cancelEdit });
    render(<App />);
    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    ev.preventDefault();
    window.dispatchEvent(ev);
    expect(cancelEdit).not.toHaveBeenCalled();
  });

  it("Escape closes the actions menu, then an action dialog, before touching the selection", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", state: "connected" }, selectedId: "Deployment/p/web", select,
      actionsMenu: { nodeId: "Deployment/p/web", x: 0, y: 0 },
    });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().actionsMenu).toBeNull();
    useAppStore.setState({ actionDialog: { type: "restart", nodeId: "Deployment/p/web" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().actionDialog).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("Escape closes the port-forward popover before touching the selection", () => {
    const select = vi.fn(async () => {});
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" }, selectedId: "Pod/p/a", select, forwardsOpen: true });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().forwardsOpen).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it("Escape closes the forward dialog", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" }, actionDialog: { type: "forward", nodeId: "Service/p/web" } });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().actionDialog).toBeNull();
  });

  it("Escape does not close the action dialog while the action is in flight", () => {
    useAppStore.setState({
      connection: { ...initialState().connection, context: "prod", state: "connected" },
      actionDialog: { type: "restart", nodeId: "Deployment/p/web" }, actionBusy: true,
    });
    render(<App />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useAppStore.getState().actionDialog).not.toBeNull();
  });
});
