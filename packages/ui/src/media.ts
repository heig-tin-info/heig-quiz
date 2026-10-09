/**
 * The window's media queries, read one way for the app and the question
 * types alike. Where `matchMedia` does not exist (a test, the server) the
 * answer is the caller's `fallback`: the layout it would rather draw there.
 */
import { useSyncExternalStore } from "react";

const supported = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function";

/** True when `query` matches, following the window as it changes. */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (!supported()) return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => (supported() ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** Whether the reader asked for no motion (`prefers-reduced-motion`); false where it cannot be asked. */
export function prefersReducedMotion(): boolean {
  return supported() && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
