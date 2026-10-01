import { vi } from "vitest";

/**
 * A viewport at least `width` wide: `useMinWidth` reads `matchMedia`, and
 * jsdom has no layout. Undo it with the setup's narrow stub, kept before the
 * call (`const narrow = window.matchMedia`).
 */
export function viewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity) <= width,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}
