import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KindChips } from "./KindChips";

describe("KindChips", () => {
  it("renders one chip per watched kind, marks hidden and denied kinds, toggles on click", () => {
    const onToggle = vi.fn();
    render(<KindChips hidden={new Set(["Secret"])} denied={new Set(["ConfigMap"])} present={new Set(["Pod", "Secret", "ConfigMap"])} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: /Secret/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /Pod/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /ConfigMap/ })).toHaveAttribute("title", "No access (RBAC)");
    fireEvent.click(screen.getByRole("button", { name: /Secret/ }));
    expect(onToggle).toHaveBeenCalledWith("Secret");
  });
});
