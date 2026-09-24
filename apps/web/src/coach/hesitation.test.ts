import { describe, expect, it } from "vitest";

import { freshState, isHesitating, THRESHOLDS } from "./hesitation";

const T0 = 1_000_000;
const late = T0 + THRESHOLDS.quietMs + 1;

describe("isHesitating", () => {
  it("is never true before the quiet period, however busy the pointer", () => {
    const s = { ...freshState(T0), path: 50_000, hovered: 40, lastActivity: T0 + 1000 };
    expect(isHesitating(s, T0 + 5000)).toBe(false);
  });

  it("is not idle: a reader who left the page is not stuck", () => {
    const s = { ...freshState(T0), path: 50_000, lastActivity: T0 + 1000 };
    expect(isHesitating(s, late)).toBe(false);
  });

  it("is not reading: present but calm is working", () => {
    const s = { ...freshState(T0), path: 400, hovered: 1, lastActivity: late - 500 };
    expect(isHesitating(s, late)).toBe(false);
  });

  it.each([
    ["a long pointer path", { path: THRESHOLDS.path }],
    ["several controls brushed past", { hovered: THRESHOLDS.hovered }],
    ["the page scrolled back and forth", { reversals: THRESHOLDS.reversals }],
  ])("is searching: %s", (_label, extra) => {
    const s = { ...freshState(T0), lastActivity: late - 500, ...extra };
    expect(isHesitating(s, late)).toBe(true);
  });
});
