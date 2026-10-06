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
    expect(screen.getByRole("region", { name: "Nothing here yet" })).toHaveTextContent("shop has no resources.");
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
});
