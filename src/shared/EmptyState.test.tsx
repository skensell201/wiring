import { fireEvent, render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("names its region by the title and runs its actions", () => {
    const create = vi.fn();
    const pick = vi.fn();
    render(
      <EmptyState icon={Inbox} title="Nothing here yet" primary={{ label: "+ Create", onClick: create }} secondary={{ label: "Pick another namespace", onClick: pick }}>
        shop has no resources.
      </EmptyState>,
    );
    expect(screen.getByRole("status", { name: "Nothing here yet" })).toHaveTextContent("shop has no resources.");
    fireEvent.click(screen.getByRole("button", { name: "+ Create" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick another namespace" }));
    expect(create).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledOnce();
  });

  it("has no buttons without actions", () => {
    render(<EmptyState icon={Inbox} title="Loading shop…" spinning />);
    expect(screen.getByRole("heading", { name: "Loading shop…" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("announces an error as an alert", () => {
    render(<EmptyState icon={Inbox} title="Connection failed" tone="error" />);
    expect(screen.getByRole("alert", { name: "Connection failed" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is busy only while spinning", () => {
    const { rerender } = render(<EmptyState icon={Inbox} title="Connecting…" spinning />);
    expect(screen.getByRole("status", { name: "Connecting…" })).toHaveAttribute("aria-busy", "true");
    rerender(<EmptyState icon={Inbox} title="Connecting…" />);
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-busy");
  });

  it("renders a single action alone", () => {
    render(<EmptyState icon={Inbox} title="No access" secondary={{ label: "Back", onClick: () => {} }} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("wraps long unbroken text", () => {
    render(<EmptyState icon={Inbox} title="Failed">{"https://example.com/" + "a".repeat(200)}</EmptyState>);
    expect(screen.getByRole("heading", { name: "Failed" })).toHaveClass("break-words");
    expect(screen.getByText(/^https:\/\/example/)).toHaveClass("break-words");
  });

  it("can move focus to its primary action", () => {
    render(<EmptyState icon={Inbox} title="Connection failed" tone="error" autoFocusPrimary primary={{ label: "Retry", onClick: () => {} }} secondary={{ label: "Back", onClick: () => {} }} />);
    expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();
  });

  it("leaves focus alone by default", () => {
    render(<EmptyState icon={Inbox} title="Nothing here yet" primary={{ label: "+ Create", onClick: () => {} }} />);
    expect(screen.getByRole("button", { name: "+ Create" })).not.toHaveFocus();
  });
});
