import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

const props = { open: true, title: "Delete Pod web-1?", body: "This cannot be undone.", confirmLabel: "Delete", onConfirm: vi.fn(), onCancel: vi.fn() };

describe("ConfirmDialog", () => {
  it("renders nothing when closed", () => {
    render(<ConfirmDialog {...props} open={false} />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("is an alertdialog named by its title, with the body and both buttons", () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    render(<ConfirmDialog {...props} onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = screen.getByRole("alertdialog", { name: "Delete Pod web-1?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("Escape cancels and marks the event handled so the global handler leaves it alone", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...props} onCancel={onCancel} />);
    const seen = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    window.addEventListener("keydown", seen);
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", seen);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(seen).toHaveReturnedWith(true);
  });

  it("focuses Cancel by default so Enter never confirms a destructive action by accident", () => {
    render(<ConfirmDialog {...props} danger />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
