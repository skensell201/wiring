import "@testing-library/jest-dom/vitest";

// React Flow measures nodes with ResizeObserver; jsdom has none.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
