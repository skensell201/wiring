import { useEffect } from "react";
import { useUpdateStore } from "./updateStore";

export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Background update checks: 10 s after start, then every 6 hours. Off in `vite dev`. */
export function useUpdateChecker(enabled: boolean = !import.meta.env.DEV): void {
  useEffect(() => {
    if (!enabled) return;
    const check = () => void useUpdateStore.getState().check(false);
    let every: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => { check(); every = setInterval(check, CHECK_EVERY_MS); }, FIRST_CHECK_MS);
    return () => { clearTimeout(first); if (every) clearInterval(every); };
  }, [enabled]);
}
