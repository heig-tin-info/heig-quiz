import { describe, expect, it } from "vitest";

import { fitScale, layoutWidthFor, MAX_WIDEN, MIN_FIT_SCALE, nextProbe } from "./fit";

/*
 * The arithmetic behind the one thing a projection may not do: scroll. The
 * component itself only measures two boxes and hands them here, so this is
 * where the rules are checked — it never magnifies, it never rounds up into a
 * clipped last bar, and a box nobody has measured yet leaves it alone.
 */

describe("fitScale", () => {
  it("leaves content that already fits alone", () => {
    expect(fitScale(1000, 400, 1200, 600)).toBe(1);
    // Exactly the height of the area is a fit, not an overflow.
    expect(fitScale(1200, 600, 1200, 600)).toBe(1);
  });

  it("never magnifies a small question to fill the wall", () => {
    // Half the area in both directions: the clamp() scale of the screen is
    // what the designer picked, and it stays.
    expect(fitScale(600, 300, 1200, 600)).toBe(1);
  });

  it("shrinks by the tighter of the two dimensions", () => {
    // 1280 x 720 with eight two-line choices: the height is what gives.
    expect(fitScale(1200, 1200, 1200, 600)).toBe(0.5);
    // A block wider than the area shrinks by the width instead.
    expect(fitScale(2000, 300, 1000, 600)).toBe(0.5);
    // Both too big: the smaller factor wins, so nothing overflows.
    expect(fitScale(2000, 1200, 1000, 900)).toBe(0.5);
  });

  it("rounds down, so a fit is never a pixel too tall", () => {
    // 1/3 is 0.333… — rounded up it would overflow a container that hides it.
    const k = fitScale(100, 300, 100, 100);
    expect(k).toBe(0.333);
    expect(300 * k).toBeLessThanOrEqual(100);
  });

  it("ignores a dimension that has not been measured", () => {
    // First paint, a detached node, a hidden tab: zero is "unknown", never
    // "an infinitely small screen".
    expect(fitScale(0, 0, 0, 0)).toBe(1);
    expect(fitScale(1200, 1200, 1200, 0)).toBe(1);
    expect(fitScale(1200, 0, 1200, 600)).toBe(1);
    expect(fitScale(Number.NaN, Number.NaN, 1200, 600)).toBe(1);
    // One usable pair is enough to fit by it.
    expect(fitScale(0, 1200, 0, 600)).toBe(0.5);
  });

  it("stops at the floor rather than drawing a smudge", () => {
    expect(fitScale(100, 10_000, 100, 100)).toBe(MIN_FIT_SCALE);
  });
});

describe("layoutWidthFor", () => {
  it("is the widest layout a scale may use without spilling sideways", () => {
    // Drawn width is layout x scale, and it has to land exactly on the area.
    expect(layoutWidthFor(1200, 0.5)).toBe(2400);
    expect(layoutWidthFor(1200, 0.5) * 0.5).toBe(1200);
    // A block that already fits is laid out at the area's own width.
    expect(layoutWidthFor(1200, 1)).toBe(1200);
  });

  it("caps the pathological end rather than asking for a line nobody reads", () => {
    expect(layoutWidthFor(1200, MIN_FIT_SCALE)).toBe(1200 * MAX_WIDEN);
  });

  it("says nothing about an area nobody has measured", () => {
    expect(layoutWidthFor(0, 0.5)).toBe(0);
    expect(layoutWidthFor(Number.NaN, 0.5)).toBe(0);
    // A scale out of range falls back to "as wide as the area".
    expect(layoutWidthFor(1200, Number.NaN)).toBe(1200);
  });
});

describe("nextProbe", () => {
  it("halves the bracket when the last layout did not fit", () => {
    // Rounded down to the thousandth, like every scale here: a probe that
    // rounded up would be a candidate the measurement never verified.
    expect(nextProbe(0.36, 1)).toBe(0.679);
    expect(nextProbe(0.68, 1)).toBe(0.84);
    expect(nextProbe(0.36, 0.68)).toBe(0.52);
  });

  it("aims at the slack the last fitting layout left", () => {
    // The block drew 429/1.66 of the area's height, so there is room for
    // about two thirds again as much scale — try that rather than a blind
    // half-step.
    expect(nextProbe(0.41, 1, 1.66)).toBe(0.68);
    // Nearly no slack left: the guess is a hair above, and the search is done
    // in all but name.
    expect(nextProbe(0.6, 0.68, 1.002)).toBe(0.601);
  });

  it("stays inside the bracket, so the search cannot walk out of it", () => {
    // An over-eager guess (nothing left to gain from a wider layout) and a
    // useless one both fall back to the half-step.
    expect(nextProbe(0.4, 0.9, 4)).toBe(0.65);
    expect(nextProbe(0.4, 0.9, 1)).toBe(0.65);
    expect(nextProbe(0.4, 0.9, Number.NaN)).toBe(0.65);
    const mid = nextProbe(0.4, 0.9);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.9);
  });
});
