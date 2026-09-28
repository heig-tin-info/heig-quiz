import { describe, expect, it } from "vitest";

import { fitRowHeight, ROW_MAX_PX, ROW_MIN_PX } from "./useRowDensity";

/*
 * The arithmetic of #227 on its own: jsdom has no layout, so the hook's
 * measurements are all zeros there, and what is worth holding is the rule
 * that turns a measured page into a row height.
 */
describe("fitRowHeight (#227)", () => {
  const page = { viewport: 1080, top: 200, chrome: 80, below: 60 };

  it("shares what the viewport leaves among the rows", () => {
    // 1080 - 200 - 80 - 60 = 740 px for 25 rows: 29.6, floored.
    expect(fitRowHeight({ ...page, rows: 25 })).toBe(29);
  });

  it("never grows a small class past the maximum", () => {
    expect(fitRowHeight({ ...page, rows: 3 })).toBe(ROW_MAX_PX);
  });

  it("never squeezes a big class under the minimum: the page scrolls instead", () => {
    expect(fitRowHeight({ ...page, rows: 120 })).toBe(ROW_MIN_PX);
    // A window so short that nothing is left at all.
    expect(fitRowHeight({ ...page, viewport: 300, rows: 10 })).toBe(ROW_MIN_PX);
  });

  it("falls back to the maximum when there is nothing to measure", () => {
    expect(fitRowHeight({ ...page, rows: 0 })).toBe(ROW_MAX_PX);
    expect(fitRowHeight({ ...page, viewport: 0, rows: 20 })).toBe(ROW_MAX_PX);
    expect(fitRowHeight({ ...page, viewport: Number.NaN, rows: 20 })).toBe(ROW_MAX_PX);
  });
});
