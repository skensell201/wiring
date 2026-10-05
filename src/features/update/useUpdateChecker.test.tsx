import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/ipc/tauri", () => ({ invoke: vi.fn(async () => ({ current: "0.2.0", update: null })), listen: vi.fn(async () => () => {}), Channel: class {} }));

import { invoke } from "../../shared/ipc/tauri";
import { CHECK_EVERY_MS, FIRST_CHECK_MS, useUpdateChecker } from "./useUpdateChecker";

const checks = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "check_update").length;

beforeEach(() => { vi.useFakeTimers(); vi.mocked(invoke).mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe("useUpdateChecker", () => {
  it("checks 10 s after start, then every 6 hours, and stops on unmount", async () => {
    const { unmount } = renderHook(() => useUpdateChecker(true));
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(checks()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(checks()).toBe(2);
    unmount();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(checks()).toBe(2);
  });

  it("never checks when disabled (dev builds)", async () => {
    renderHook(() => useUpdateChecker(false));
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(checks()).toBe(0);
  });
});
