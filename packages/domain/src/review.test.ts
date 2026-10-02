import { describe, expect, it } from "vitest";

import { applyFix, isReviewNight, parsePath, reviewPill, valueAt, withValueAt, worstSeverity } from "./review.js";

describe("isReviewNight", () => {
  it("is 01:00 to 06:00 in Zurich, summer and winter", () => {
    // 2026-07-01 00:30 UTC is 02:30 in Zurich (CEST).
    expect(isReviewNight(new Date("2026-07-01T00:30:00Z"))).toBe(true);
    // 2026-07-01 22:30 UTC is 00:30 the next day in Zurich.
    expect(isReviewNight(new Date("2026-07-01T22:30:00Z"))).toBe(false);
    // 2026-12-01 04:59 UTC is 05:59 in Zurich (CET); 05:00 UTC is 06:00.
    expect(isReviewNight(new Date("2026-12-01T04:59:00Z"))).toBe(true);
    expect(isReviewNight(new Date("2026-12-01T05:00:00Z"))).toBe(false);
  });
});

describe("worstSeverity", () => {
  it("is error, then warn, then notice", () => {
    expect(worstSeverity(["notice", "error", "warn"])).toBe("error");
    expect(worstSeverity(["notice"])).toBe("notice");
    expect(worstSeverity([])).toBeNull();
  });
});

describe("reviewPill", () => {
  it("counts the open findings, none once ignored", () => {
    const findings = [{ severity: "notice" as const }, { severity: "warn" as const }];
    expect(reviewPill("findings", findings)).toEqual({ state: "findings", count: 2, worst: "warn" });
    expect(reviewPill("ignored", findings)).toEqual({ state: "ignored", count: 0, worst: null });
    expect(reviewPill("clean", [])).toEqual({ state: "clean", count: 0, worst: null });
  });
});

describe("paths", () => {
  const config = { prompt: "P", choices: [{ text: "a", correct: true }, { text: "b", correct: false }] };

  it("read and replace a value, copying along the way", () => {
    const path = parsePath("choices.1.correct")!;
    expect(path).toEqual(["choices", 1, "correct"]);
    expect(valueAt(config, path)).toBe(false);
    const next = withValueAt(config, path, true) as typeof config;
    expect(next.choices[1]!.correct).toBe(true);
    expect(config.choices[1]!.correct).toBe(false);
    expect(next.choices[0]).toBe(config.choices[0]);
  });

  it("refuse what is no path, and a path that does not exist", () => {
    expect(parsePath("a..b")).toBeNull();
    expect(parsePath("__proto__.x")).toBeNull();
    expect(withValueAt(config, ["nope", "x"], 1)).toBeNull();
    expect(valueAt(config, ["choices", 7, "text"])).toBeUndefined();
  });
});

describe("applyFix", () => {
  it("replaces a text that occurs exactly once", () => {
    expect(applyFix("Le resultat est 4.", "resultat", "résultat")).toBe("Le résultat est 4.");
    expect(applyFix("a a", "a", "b")).toBeNull();
    expect(applyFix("abc", "x", "y")).toBeNull();
    expect(applyFix("abc", "", "y")).toBeNull();
  });

  it("flips a tick only from what it holds, and touches nothing else", () => {
    expect(applyFix(false, "false", "true")).toBe(true);
    expect(applyFix(true, "false", "true")).toBeNull();
    expect(applyFix(false, "false", "maybe")).toBeNull();
    expect(applyFix(3, "3", "4")).toBeNull();
    expect(applyFix(null, "a", "b")).toBeNull();
  });
});
