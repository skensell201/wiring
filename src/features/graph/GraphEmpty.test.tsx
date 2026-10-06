import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/ipc/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
}));
import { GraphEmpty } from "./GraphEmpty";

describe("GraphEmpty too large", () => {
  it("offers the tables alone for a single namespace", () => {
    render(<GraphEmpty state={{ type: "tooLarge", count: 1873, scope: "shop", canNarrow: false }} />);
    expect(screen.getByRole("button", { name: "Open tables" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fewer namespaces/ })).toBeNull();
    expect(screen.getByText(/1,873 objects in shop/).textContent).not.toMatch(/fewer namespaces/);
  });

  it("also offers the picker for several namespaces", () => {
    render(<GraphEmpty state={{ type: "tooLarge", count: 1873, scope: "shop, blog", canNarrow: true }} />);
    expect(screen.getByRole("button", { name: "Pick fewer namespaces" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open tables" })).toBeInTheDocument();
    expect(screen.getByText(/1,873 objects in shop, blog/).textContent).toMatch(/or pick fewer namespaces/);
  });
});
