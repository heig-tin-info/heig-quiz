import { vi } from "vitest";

/** `matchMedia` answering `matches` for each query: jsdom has no layout. */
function stubMedia(matches: (query: string) => boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

/**
 * A viewport at least `width` wide: `useMinWidth` reads `matchMedia`, and
 * jsdom has no layout. Undo it with the setup's narrow stub, kept before the
 * call (`const narrow = window.matchMedia`).
 */
export function viewport(width: number) {
  stubMedia((query) => Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity) <= width);
}

/**
 * A low screen (#450): a phone in landscape, under `lg` and at most 480 px
 * tall — `useLowScreen`'s query matches, every other one does not. Undo it
 * as `viewport`'s.
 */
export function lowScreen() {
  stubMedia((query) => query.includes("max-height: 480px"));
}

/**
 * A phone held upright (#849): under `sm` wide — `usePhoneScreen`'s query
 * matches, and neither a low screen's nor any `min-width` one does. Undo it
 * as `viewport`'s.
 */
export function phoneScreen() {
  stubMedia((query) => query.includes("max-width: 639.98px"));
}
