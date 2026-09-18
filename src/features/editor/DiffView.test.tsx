import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffView } from "./DiffView";

describe("DiffView", () => {
  it("marks added, removed and unchanged lines and counts the changed ones", () => {
    render(<DiffView original={"a: 1\nb: 2\nc: 3\n"} next={"a: 1\nb: 5\nc: 3\nd: 4\n"} />);
    expect(screen.getByText("3 lines changed")).toBeInTheDocument();
    const lines = screen.getAllByTestId("diff-line");
    expect(lines.map((l) => l.dataset.diff)).toEqual(["same", "del", "add", "same", "add"]);
    expect(lines.map((l) => l.textContent)).toEqual(["  a: 1", "- b: 2", "+ b: 5", "  c: 3", "+ d: 4"]);
  });

  it("says so when nothing changed", () => {
    render(<DiffView original={"a: 1\n"} next={"a: 1\n"} />);
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("uses the singular for one changed line", () => {
    render(<DiffView original={"a: 1\n"} next={"a: 1\nb: 2\n"} />);
    expect(screen.getByText("1 line changed")).toBeInTheDocument();
  });
});
