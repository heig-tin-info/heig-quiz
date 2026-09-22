/**
 * How much the projection has to shrink so a question fits the wall.
 *
 * The beamer screen never scrolls (`apps/web/DESIGN.md`, "Projection"): the
 * whole question, all its bars and the reveal have to be on the wall at once,
 * because a scrollbar on a projection is content nobody in the room will ever
 * see. `questionScale()` already steps the TITLE down by the length of the
 * prompt, but it knows nothing about how many choices follow it or how long
 * each one is — eight two-line choices overflow a 1280 × 720 projector with a
 * short question just as well.
 *
 * So the last word is a measurement, taken in the browser and turned into a
 * `transform: scale()` by `PollProjection`. The arithmetic lives here, pure,
 * because it is the one part of a screen built out of `clamp()` sizes that can
 * be unit-tested.
 *
 * Why a transform rather than a root font size: every size on that screen is a
 * `clamp()` of `vw`/`vh` units, not of `rem` — DESIGN.md makes the viewport,
 * not the type scale, the ruler of this one page. A root font size would move
 * none of them. A transform moves all of them together, keeps the ratios the
 * designer picked, and scales text and bars as one block; the browser still
 * rasterises the text at the scaled size, so it stays crisp.
 *
 * And why the block is WIDENED before it is scaled: scaling a block laid out
 * at the width of the area shrinks it away from both side edges, so the wall
 * ends up two thirds empty and the text half the size the room can read. A
 * choice that wraps onto two lines at 1150 px fits on one at 2300 px, which
 * costs nothing on a screen that is about to be scaled down anyway. So the fit
 * is a search: `layoutWidthFor()` gives the widest layout a given scale may
 * use without spilling sideways, the browser measures the height that layout
 * costs, and the largest scale whose measured height still fits is the one
 * applied. The search is short (`FIT_PROBES` measurements), every candidate is
 * verified rather than predicted, and what is applied is always a pair the
 * browser really measured — so it cannot oscillate between two frames.
 */

/**
 * Never below a fifth. A scale that small means the payload is pathological
 * (a wall of text no room could read at any size) and the projection stops
 * chasing it rather than drawing a grey smudge; the eight-row cap
 * (`PROJECTION_ROW_CAP`) keeps every real poll far above this floor.
 */
export const MIN_FIT_SCALE = 0.2;

function usable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The factor the content block must be scaled by to fit the area, in `]0, 1]`.
 *
 * It never magnifies: `1` is "it already fits", and the projection's own
 * `clamp()` scale stays exactly as designed whenever it does. A dimension that
 * has not been measured yet (0, NaN, a detached node) is ignored rather than
 * taken as an infinitely small screen, so the first paint is never a speck.
 *
 * The result is rounded DOWN to the thousandth: rounding up is how a fit comes
 * out one pixel too tall, which on a container with `overflow: hidden` is a
 * clipped last bar.
 */
export function fitScale(
  contentW: number,
  contentH: number,
  availW: number,
  availH: number,
): number {
  let k = 1;
  if (usable(contentW) && usable(availW)) k = Math.min(k, availW / contentW);
  if (usable(contentH) && usable(availH)) k = Math.min(k, availH / contentH);
  if (k >= 1) return 1;
  return Math.max(MIN_FIT_SCALE, Math.floor(k * 1000) / 1000);
}

/**
 * How wide the block may be laid out if it is going to be drawn at `scale`.
 *
 * Drawn width is layout width times the scale, and it may not exceed the area:
 * `availW / scale` is therefore the widest layout that still fits sideways,
 * and it is exactly the one to use — a narrower one would leave the wall's
 * edges empty for nothing. The cap is there for the pathological end of the
 * range, where a scale near the floor would ask for a ten-thousand-pixel line
 * length that no reflow can turn into a readable wall.
 */
export const MAX_WIDEN = 4;

export function layoutWidthFor(availW: number, scale: number): number {
  if (!usable(availW)) return 0;
  const k = usable(scale) ? Math.min(1, Math.max(MIN_FIT_SCALE, scale)) : 1;
  return Math.round(Math.min(availW / k, availW * MAX_WIDEN));
}

/** How many layouts the search is allowed to measure before it settles. */
export const FIT_PROBES = 4;

/**
 * The next scale to measure, inside a bracket whose low end `lo` is a scale
 * that was measured and does fit, and whose high end `hi` is one that does
 * not.
 *
 * `slack` is how much room the last fitting layout left: the area's height
 * over the height that layout actually drew, so `1.6` means "the block could
 * have been 60 % taller". Growing `lo` by it is where the fit would land if
 * widening a block cost nothing in height; it overshoots, because a wider
 * layout is never quite as short as the one before — which is why the guess is
 * measured before it is applied and falls back to halving the bracket when it
 * lands outside it. Height is not a smooth function of width (it steps each
 * time a label stops wrapping), so a guess is a candidate, never an answer.
 *
 * `lo` is always a verified fit, so the worst case of the whole search is the
 * un-widened scale it started from.
 */
export function nextProbe(lo: number, hi: number, slack = 0): number {
  const guess = usable(slack) && slack > 1 ? lo * slack : 0;
  const next = guess > lo && guess < hi ? guess : (lo + hi) / 2;
  return Math.floor(next * 1000) / 1000;
}
