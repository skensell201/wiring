import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";

// vi.mock is hoisted above imports, so shared state must be hoisted too.
const hoisted = vi.hoisted(() => ({
  unsub1: vi.fn(),
  unsub2: vi.fn(),
  calls: 0,
  startup: vi.fn(async () => {}),
}));
vi.mock("./startup", () => ({ startup: hoisted.startup }));
vi.mock("./wireEvents", () => ({
  wireEvents: vi.fn(async () => (hoisted.calls++ === 0 ? hoisted.unsub1 : hoisted.unsub2)),
}));

describe("App shell (StrictMode)", () => {
  it("does not leak the discarded first mount's subscription and only starts up once", async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await act(async () => {});
    await act(async () => {});

    expect(hoisted.startup).toHaveBeenCalledTimes(1);
    expect(hoisted.unsub1).toHaveBeenCalledTimes(1);
    expect(hoisted.unsub2).not.toHaveBeenCalled();
  });
});
