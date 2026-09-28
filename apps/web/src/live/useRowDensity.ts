/*
 * How tall one row of the live grid may be so that the whole class fits on
 * the screen (#227).
 *
 * A teacher watches thirty students from the back of a room, often on a
 * projector, and a grid that needs scrolling is a grid of which half is never
 * seen. So the row height is not a constant: it is what is left of the
 * viewport under the grid's top, minus the grid's own header and footer and
 * what the page puts under it (the legend), shared among the rows — clamped
 * so a class of five does not get 80 px balloons and a class of sixty does
 * not get unreadable slivers. Under the minimum the grid simply grows past
 * the screen and the page scrolls, as it always did.
 *
 * The number is handed to CSS as `--row-h` on the grid's wrapper; the rows
 * and their cells follow it there, so React never re-renders a row to change
 * its height.
 */
import { useLayoutEffect, useState } from "react";

/** Under this a 13 px name and a cell glyph stop being readable. */
export const ROW_MIN_PX = 24;
/** Over this a small class looks like a form, not a grid. */
export const ROW_MAX_PX = 36;

/**
 * The height of one row, in whole pixels, given what the page measured.
 * Pure, so it is tested without a layout engine.
 *
 * - `viewport`: the height of the visible area (`innerHeight`, or the full
 *   screen stage's height);
 * - `top`: where the grid starts, from the top of that area when scrolled to
 *   the very top — so scrolling never changes the answer;
 * - `chrome`: the grid's header and footer rows, which do not shrink;
 * - `below`: whatever must stay visible under the grid (legend, gaps);
 * - `rows`: the student rows to fit.
 *
 * Anything it cannot use (no rows, a measurement that is not a positive
 * number) gives the maximum: the grid as it looks when nothing is squeezed.
 */
export function fitRowHeight({
  viewport,
  top,
  chrome,
  below,
  rows,
}: {
  viewport: number;
  top: number;
  chrome: number;
  below: number;
  rows: number;
}): number {
  if (!(rows > 0) || !(viewport > 0)) return ROW_MAX_PX;
  const available = viewport - top - chrome - below;
  if (!Number.isFinite(available)) return ROW_MAX_PX;
  return Math.min(ROW_MAX_PX, Math.max(ROW_MIN_PX, Math.floor(available / rows)));
}

/** Distance from the element to the top of its page (or of a fixed stage), scroll-free. */
function offsetTopOf(el: HTMLElement): number {
  let top = 0;
  for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) {
    top += node.offsetTop;
  }
  return top;
}

/**
 * The padding under the page's content: every ancestor's `padding-bottom`,
 * summed — the Shell's `<main>` in the page, the stage's own in the page's
 * full screen. Read from the DOM rather than copied from `Shell.tsx`, so
 * restyling either does not silently cut the legend off.
 */
function paddingBelow(el: HTMLElement): number {
  let sum = 0;
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    sum += Number.parseFloat(getComputedStyle(node).paddingBottom) || 0;
  }
  return sum;
}

/** Everything laid out before the grid in its parents: the header, the switches, a banner. */
function blocksAbove(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
      if (prev instanceof HTMLElement) out.push(prev);
    }
  }
  return out;
}

/**
 * The row height for the grid, re-measured when the window resizes (which is
 * also what entering the browser's full screen does, F-DASH-06) and when
 * anything that moves the grid's top or its bottom margin changes size: the
 * header and the switches above it (a title that wraps, "Go to grading"
 * appearing), its own header and footer rows, the legend under it.
 *
 * The two elements come in through CALLBACK refs, held in state: the grid is
 * mounted late (after the lobby, after loading) and remounted when the page
 * enters its own full-screen stage, and an effect keyed on a ref object
 * would keep measuring — and observing — the element that is gone.
 *
 * The space between the grid and the block under it is measured too, as is
 * the page's bottom padding (`paddingBelow`): no number here is copied from
 * the layout.
 *
 * jsdom has no layout: every size is 0, and a grid of height 0 is read as
 * "not laid out" and left at the maximum rather than computed from zeros.
 */
export function useRowDensity(rows: number): {
  rowHeight: number;
  gridRef: (el: HTMLElement | null) => void;
  belowRef: (el: HTMLElement | null) => void;
} {
  const [grid, gridRef] = useState<HTMLElement | null>(null);
  const [below, belowRef] = useState<HTMLElement | null>(null);
  const [rowHeight, setRowHeight] = useState(ROW_MAX_PX);
  useLayoutEffect(() => {
    if (!grid) return;
    const thead = grid.querySelector("thead");
    const tfoot = grid.querySelector("tfoot");
    const measure = () => {
      if (grid.offsetHeight === 0) {
        setRowHeight(ROW_MAX_PX);
        return;
      }
      // The gap between the grid and the legend, as laid out (`space-y-5`).
      // A hidden legend (the lobby) has no box, and reserves nothing.
      const gap =
        below && below.offsetHeight > 0
          ? Math.max(0, below.getBoundingClientRect().top - grid.getBoundingClientRect().bottom)
          : 0;
      setRowHeight(
        fitRowHeight({
          viewport: window.innerHeight,
          top: offsetTopOf(grid),
          // The card's borders and the rows' hairlines ride with the chrome.
          chrome: (thead?.offsetHeight ?? 0) + (tfoot?.offsetHeight ?? 0) + rows + 2,
          below: (below?.offsetHeight ?? 0) + gap + paddingBelow(grid),
          rows,
        }),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    // Sizes that change without the window doing so. Observing them — never
    // the rows, whose height is the OUTPUT, nor anything that contains them —
    // cannot loop: none of them depends on `--row-h`.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const el of [thead, tfoot, below, ...blocksAbove(grid)]) {
      if (el) observer?.observe(el);
    }
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [grid, below, rows]);
  return { rowHeight, gridRef, belowRef };
}
