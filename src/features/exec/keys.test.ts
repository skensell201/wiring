import { describe, expect, it } from "vitest";
import { keyAction } from "./keys";

const key = (init: Partial<KeyboardEvent> & { key: string }, type = "keydown") => ({ type, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...init }) as KeyboardEvent;

describe("keyAction", () => {
  it("Ctrl+Shift+Tab leaves the terminal on every platform, without reaching the shell", () => {
    expect(keyAction(key({ key: "Tab", ctrlKey: true, shiftKey: true }), false)).toBe("leave");
    // Its keyup is swallowed as well, but only the keydown moves focus.
    expect(keyAction(key({ key: "Tab", ctrlKey: true, shiftKey: true }, "keyup"), false)).toBe("swallow");
  });
  it("plain Tab and Shift+Tab still belong to the shell", () => {
    expect(keyAction(key({ key: "Tab" }), false)).toBe("pass");
    expect(keyAction(key({ key: "Tab", shiftKey: true }), false)).toBe("pass");
    expect(keyAction(key({ key: "Tab", ctrlKey: true }), false)).toBe("pass");
  });
  it("copies the selection with Cmd+C or Ctrl+Shift+C, else passes Ctrl+C to the shell", () => {
    expect(keyAction(key({ key: "c", metaKey: true }), true)).toBe("copy");
    expect(keyAction(key({ key: "C", ctrlKey: true, shiftKey: true }), true)).toBe("copy");
    expect(keyAction(key({ key: "c", ctrlKey: true }), true)).toBe("pass");
    expect(keyAction(key({ key: "c", metaKey: true }), false)).toBe("pass");
  });
});
