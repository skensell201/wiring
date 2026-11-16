/** True on macOS, where the window uses an overlay title bar and the traffic lights need room. */
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform ?? "");

/** True on Linux, where there is no OS installer to carry the brand: the app's own first run
 *  sheet does that job instead. */
export const isLinux = typeof navigator !== "undefined" && /Linux/.test(navigator.platform ?? "");
