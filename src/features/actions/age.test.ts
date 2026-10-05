import { describe, expect, it } from "vitest";
import { age } from "./age";

describe("age", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  it("formats seconds, minutes, hours and days", () => {
    expect(age("2026-10-05T11:59:15Z", now)).toBe("45s");
    expect(age("2026-10-05T11:48:00Z", now)).toBe("12m");
    expect(age("2026-10-05T09:00:00Z", now)).toBe("3h");
    expect(age("2026-09-30T12:00:00Z", now)).toBe("5d");
  });
  it("shows a dash for a missing or unparseable time", () => {
    expect(age(null, now)).toBe("—");
    expect(age("soon", now)).toBe("—");
  });
});
