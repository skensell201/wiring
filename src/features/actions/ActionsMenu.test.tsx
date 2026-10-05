import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { initialState, useAppStore } from "../../app/store";
import { ActionsMenu } from "./ActionsMenu";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), Channel: class { onmessage: (m: unknown) => void = () => {}; } }));

const open = (nodeId: string) => useAppStore.setState({ actionsMenu: { nodeId, x: 40, y: 60 } });
const items = () => screen.getAllByRole("menuitem").map((b) => b.textContent);

beforeEach(() => useAppStore.setState(initialState()));

describe("ActionsMenu", () => {
  it("renders nothing while closed", () => {
    render(<ActionsMenu />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("lists the actions for the kind and focuses the first", () => {
    open("Deployment/p/web");
    render(<ActionsMenu />);
    expect(items()).toEqual(["Scale…", "Restart", "Rollback…", "Port-forward…", "Delete…"]);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Scale…" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Restart" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete…" }));
  });

  it("offers only Delete for kinds without rollout actions", () => {
    open("PodGroup/p/Deployment/web");
    render(<ActionsMenu />);
    expect(items()).toEqual(["Delete…"]);
  });

  it("Scale and Restart open their dialogs; Rollback asks for the History tab; Delete asks to delete", () => {
    open("Deployment/p/web");
    const { rerender } = render(<ActionsMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Scale…" }));
    expect(useAppStore.getState().actionDialog).toEqual({ type: "scale", nodeId: "Deployment/p/web" });
    expect(useAppStore.getState().actionsMenu).toBeNull();
    open("Deployment/p/web");
    rerender(<ActionsMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart" }));
    expect(useAppStore.getState().actionDialog).toEqual({ type: "restart", nodeId: "Deployment/p/web" });
    open("Deployment/p/web");
    rerender(<ActionsMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rollback…" }));
    expect(useAppStore.getState().requestedTab).toBe("history");
    open("Deployment/p/web");
    rerender(<ActionsMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(useAppStore.getState().deleteDialog).toEqual({ open: true, nodeId: "Deployment/p/web" });
  });

  it("Port-forward… opens the forward dialog", () => {
    open("Service/p/web");
    render(<ActionsMenu />);
    expect(items()).toEqual(["Port-forward…", "Delete…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Port-forward…" }));
    expect(useAppStore.getState().actionDialog).toEqual({ type: "forward", nodeId: "Service/p/web" });
    expect(useAppStore.getState().actionsMenu).toBeNull();
  });

  it("a click outside closes it", () => {
    open("Deployment/p/web");
    render(<ActionsMenu />);
    fireEvent.mouseDown(screen.getByTestId("actions-backdrop"));
    expect(useAppStore.getState().actionsMenu).toBeNull();
  });

  describe("positioning and focus", () => {
    const rectOf = (w: number, h: number) => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) });
    const menuEl = () => screen.getByRole("menu");
    const setViewport = (w: number, h: number) => { window.innerWidth = w; window.innerHeight = h; };
    beforeEach(() => { setViewport(1000, 800); });

    it("flips above the anchor when it would overflow the bottom", () => {
      rectOf(200, 150);
      useAppStore.setState({ actionsMenu: { nodeId: "Deployment/p/web", x: 40, y: 760, flipY: 740 } });
      render(<ActionsMenu />);
      expect(menuEl().style.top).toBe("590px");
    });

    it("flips about the pointer without a flip anchor, and horizontally by measured width", () => {
      rectOf(240, 150);
      useAppStore.setState({ actionsMenu: { nodeId: "Deployment/p/web", x: 900, y: 760 } });
      render(<ActionsMenu />);
      expect(menuEl().style.top).toBe("610px");
      expect(menuEl().style.left).toBe("752px");
    });

    it("closes on window resize", () => {
      open("Deployment/p/web");
      render(<ActionsMenu />);
      act(() => { window.dispatchEvent(new Event("resize")); });
      expect(useAppStore.getState().actionsMenu).toBeNull();
    });

    it("Escape handling aside, Tab closes the menu", () => {
      open("Deployment/p/web");
      render(<ActionsMenu />);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
      expect(useAppStore.getState().actionsMenu).toBeNull();
    });

    it("returns focus to the opener when closed, but not when an item opened a dialog", async () => {
      const Host = () => {
        const [, set] = useState(0);
        return <><button onClick={() => set(1)}>opener</button><ActionsMenu />{useAppStore.getState().actionDialog && <div role="dialog"><input aria-label="n" /></div>}</>;
      };
      const { rerender } = render(<Host />);
      const opener = screen.getByText("opener");
      opener.focus();
      act(() => open("Deployment/p/web"));
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Scale…" }));
      await act(async () => useAppStore.getState().closeActionsMenu());
      expect(document.activeElement).toBe(opener);

      act(() => open("Deployment/p/web"));
      await act(async () => { useAppStore.setState({ actionsMenu: null, actionDialog: { type: "scale", nodeId: "Deployment/p/web" } }); });
      rerender(<Host />);
      await act(async () => { screen.getByLabelText("n").focus(); });
      expect(document.activeElement).toBe(screen.getByLabelText("n"));
    });
  });
});
