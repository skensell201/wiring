import { describe, expect, it, vi } from "vitest";
import { LogBuffer } from "./logBuffer";

const line = (text: string) => ({ pod: "p", container: "c", text });

describe("LogBuffer", () => {
  it("appends with increasing seq and exposes a stable snapshot", () => {
    const b = new LogBuffer(10);
    b.append([line("a"), line("b")]);
    const first = b.lines();
    expect(first.map((l) => l.text)).toEqual(["a", "b"]);
    expect(first.map((l) => l.seq)).toEqual([1, 2]);
    expect(b.lines()).toBe(first); // no change → same array
    b.append([line("c")]);
    expect(b.lines()).not.toBe(first);
  });

  it("drops the oldest lines past its capacity", () => {
    const b = new LogBuffer(3);
    b.append([line("1"), line("2"), line("3"), line("4")]);
    expect(b.lines().map((l) => l.text)).toEqual(["2", "3", "4"]);
    b.append([line("5")]);
    expect(b.lines().map((l) => l.text)).toEqual(["3", "4", "5"]);
    expect(b.lines()[0].seq).toBe(3);
  });

  it("notifies subscribers once per frame, not once per append", () => {
    vi.useFakeTimers();
    const b = new LogBuffer(10);
    const cb = vi.fn();
    const off = b.subscribe(cb);
    b.append([line("a")]);
    b.append([line("b")]);
    expect(cb).not.toHaveBeenCalled();
    vi.runAllTimers(); // requestAnimationFrame is timer-backed in jsdom
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    b.append([line("c")]);
    vi.runAllTimers();
    expect(cb).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("clear empties and notifies", () => {
    vi.useFakeTimers();
    const b = new LogBuffer(10);
    const cb = vi.fn();
    b.subscribe(cb);
    b.append([line("a")]);
    b.clear();
    vi.runAllTimers();
    expect(b.lines()).toEqual([]);
    expect(cb).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
