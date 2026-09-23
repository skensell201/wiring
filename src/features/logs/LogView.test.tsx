import { describe, expect, it } from "vitest";
import type { BufferedLine } from "./logBuffer";
import { rowKey } from "./LogView";

const line = (seq: number): BufferedLine => ({ pod: "a", container: "app", text: `line ${seq}`, seq });

describe("rowKey", () => {
  it("keys problem rows by their stream key and line rows by seq", () => {
    const problems = [{ key: "a/app", message: "boom" }];
    const lines = [line(7), line(8)];
    expect(rowKey(problems, lines, 0)).toBe("p:a/app");
    expect(rowKey(problems, lines, 1)).toBe(7);
    expect(rowKey(problems, lines, 2)).toBe(8);
  });

  // The virtualiser caches a measured row height per key: keying by index would reuse the height
  // of a dropped line for the one that took its slot once the ring buffer saturates.
  it("gives a line the same key after older lines are dropped from the buffer", () => {
    expect(rowKey([], [line(7), line(8)], 1)).toBe(rowKey([], [line(8), line(9)], 0));
  });

  it("falls back to the index when the row is past the end", () => {
    expect(rowKey([], [line(1)], 5)).toBe(5);
  });
});
