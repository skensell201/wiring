/** True on macOS, where the window uses an overlay title bar and the traffic lights need room. */
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform ?? "");
