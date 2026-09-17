import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest.config doesn't set `test.globals`, so Testing Library's automatic
// cleanup (which detects a global `afterEach`) never registers on its own.
afterEach(cleanup);

// React Flow measures nodes with ResizeObserver; jsdom has none.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
