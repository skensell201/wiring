import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { initialState, useAppStore } from "./store";

vi.mock("../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}) }));
vi.mock("../shared/settings", () => ({ settings: { get: vi.fn(async () => null), set: vi.fn(async () => {}) } }));
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

  it("Cmd/Ctrl+K focuses the search box", () => {
    useAppStore.setState({ connection: { ...initialState().connection, context: "prod", state: "connected" } });
    render(<App />);
    fireEvent.keyDown(window, { key: "k", metaKey: true, ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/search/i));
  });
});
