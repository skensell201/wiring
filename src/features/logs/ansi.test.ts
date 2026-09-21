import { describe, expect, it } from "vitest";
import { toSpans } from "./ansi";

describe("toSpans", () => {
  it("returns one plain span for plain text", () => {
    expect(toSpans("hello")).toEqual([{ text: "hello" }]);
  });

  it("maps SGR colours to theme classes and bold", () => {
    expect(toSpans("\x1b[31mred\x1b[0m plain \x1b[1;32mbold green\x1b[0m")).toEqual([
      { text: "red", className: "ansi-red" },
      { text: " plain " },
      { text: "bold green", className: "ansi-green ansi-bold" },
    ]);
  });

  it("maps bright colours onto the same theme classes", () => {
    expect(toSpans("\x1b[91mbright red\x1b[0m")).toEqual([{ text: "bright red", className: "ansi-red" }]);
  });

  it("strips backgrounds and non-bold decorations to plain text", () => {
    expect(toSpans("\x1b[44mbg\x1b[0m \x1b[4mul\x1b[0m")).toEqual([{ text: "bg" }, { text: " " }, { text: "ul" }]);
  });

  it("drops empty spans and escapes nothing (text stays raw)", () => {
    expect(toSpans("\x1b[0m")).toEqual([]);
    expect(toSpans("<b>&")).toEqual([{ text: "<b>&" }]);
  });
});
