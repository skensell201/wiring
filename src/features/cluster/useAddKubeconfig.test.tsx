import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, useAppStore } from "../../app/store";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../shared/ipc/tauri", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
  Channel: class { onmessage: (m: unknown) => void = () => {}; },
}));

import { open } from "@tauri-apps/plugin-dialog";
import { useAddKubeconfig } from "./useAddKubeconfig";

describe("useAddKubeconfig", () => {
  beforeEach(() => useAppStore.setState(initialState()));

  it("toasts a failing file dialog instead of rejecting", async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error("dialog broke"));
    const { result } = renderHook(() => useAddKubeconfig());
    await expect(result.current()).resolves.toBeUndefined();
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ message: expect.stringContaining("dialog broke") });
  });
});
