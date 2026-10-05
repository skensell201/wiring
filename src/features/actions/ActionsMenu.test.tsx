import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(items()).toEqual(["Scale…", "Restart", "Rollback…", "Delete…"]);
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

  it("a click outside closes it", () => {
    open("Deployment/p/web");
    render(<ActionsMenu />);
    fireEvent.mouseDown(screen.getByTestId("actions-backdrop"));
    expect(useAppStore.getState().actionsMenu).toBeNull();
  });
});
