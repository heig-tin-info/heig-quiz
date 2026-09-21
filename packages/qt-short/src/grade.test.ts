/**
 * The grading truth table, through `shortServer.grade()`: one case per matcher
 * kind × match / near miss / miss (PLAN-MVP §8 WP2). The matcher semantics are
 * proven in `@quiz/domain`; what is proven here is the mapping onto the item
 * scale and the order in which the matchers are consulted.
 */
import { isGraded } from "@quiz/core/server";
import { describe, expect, it } from "vitest";
import { config, gradeContext } from "./fixtures.js";
import type { ShortConfig } from "./schema.js";
import { shortServer } from "./server.js";

function gradedNow(cfg: ShortConfig, text: string | null, points = 10) {
  const result = shortServer.grade(cfg, text === null ? null : { text }, gradeContext(points));
  if (result instanceof Promise) throw new Error("the short grader must be synchronous");
  if (!isGraded(result)) throw new Error("the short grader must never return a pending result");
  return result;
}

/** [matcher, match, near miss, miss] */
const TABLE: [string, Record<string, unknown>, string, string, string][] = [
  ["exact", { kind: "exact", value: "#include <stdio.h>" }, "#include   <stdio.h>", "#include <stdlib.h>", ""],
  ["regex", { kind: "regex", pattern: "#\\s*include\\s*[<\"]stdio\\.h[>\"]" }, "#include <stdio.h>", "include <stdio.h>", "printf"],
  ["number", { kind: "number", value: 4, tolerance: 0.5, unit: "bytes" }, "4 bytes", "5", "four"],
  ["number, relative tolerance", { kind: "number", value: 3.14, tolerance: 0.01, toleranceMode: "rel" }, "3,15", "3.2", "pi"],
  ["date", { kind: "date", value: "2026-09-20", toleranceDays: 1 }, "21.09.2026", "2026-09-25", "yesterday"],
  ["time", { kind: "time", value: "14:05", toleranceMinutes: 5 }, "14h08", "15:00", "afternoon"],
];

describe("one case per matcher kind", () => {
  for (const [name, matcher, hit, nearMiss, miss] of TABLE) {
    const cfg = config({ matchers: [matcher] } as Partial<ShortConfig>);

    it(`${name}: a match is worth the whole item`, () => {
      const result = gradedNow(cfg, hit, 4);
      expect(result.points).toBe(4);
      expect(result.details.matchedIndex).toBe(0);
    });

    it(`${name}: a near miss is worth nothing`, () => {
      expect(gradedNow(cfg, nearMiss, 4).points).toBe(0);
    });

    it(`${name}: a miss is worth nothing and names no matcher`, () => {
      const result = gradedNow(cfg, miss, 4);
      expect(result.points).toBe(0);
      expect(result.details.matchedIndex).toBeNull();
      expect(result.details.matchedKind).toBeNull();
    });
  }
});

describe("the matcher order", () => {
  const cfg = config({
    matchers: [
      { kind: "exact", value: "#include <stdio.h>" },
      { kind: "regex", pattern: "#\\s*include\\s*[<\"]stdio\\.h[>\"]", flags: "i" },
      { kind: "exact", value: "include <stdio.h>", points: 0.5 },
    ],
  } as Partial<ShortConfig>);

  it("stops at the first match", () => {
    expect(gradedNow(cfg, "#include <stdio.h>", 2).details.matchedIndex).toBe(0);
    expect(gradedNow(cfg, "#include \"stdio.h\"", 2).details.matchedIndex).toBe(1);
  });

  it("awards the matcher's own fraction", () => {
    const result = gradedNow(cfg, "include <stdio.h>", 2);
    expect(result.details.matchedIndex).toBe(2);
    expect(result.details.fraction).toBe(0.5);
    expect(result.points).toBe(1);
  });
});

/**
 * The v2 prefilters: ONE decision for the whole question, applied to the
 * student's answer and to every exact value before the comparison.
 */
describe("the prefilters", () => {
  const withPrefilters = (trim: boolean, lowercase: boolean, value = "Newton") =>
    config({
      prefilters: { trim, lowercase },
      matchers: [{ kind: "exact", value }],
    } as Partial<ShortConfig>);

  it("fold the case on both sides when `lowercase` is on (the default)", () => {
    expect(gradedNow(withPrefilters(true, true), "newton", 1).points).toBe(1);
    expect(gradedNow(withPrefilters(true, true), "NEWTON", 1).points).toBe(1);
  });

  it("make the case count when `lowercase` is off", () => {
    expect(gradedNow(withPrefilters(true, false), "Newton", 1).points).toBe(1);
    expect(gradedNow(withPrefilters(true, false), "newton", 1).points).toBe(0);
  });

  it("strip the outer spaces when `trim` is on (the default)", () => {
    expect(gradedNow(withPrefilters(true, true), "  newton  ", 1).points).toBe(1);
  });

  it("keep them when `trim` is off, on both sides", () => {
    expect(gradedNow(withPrefilters(false, true), " newton", 1).points).toBe(0);
    expect(gradedNow(withPrefilters(false, true, " Newton"), " newton", 1).points).toBe(1);
  });

  it("reach the regex input too, never its own flags", () => {
    const cfg = config({
      prefilters: { trim: true, lowercase: true },
      matchers: [{ kind: "regex", pattern: "newton", flags: "" }],
    } as Partial<ShortConfig>);
    expect(gradedNow(cfg, "  NEWTON  ", 1).points).toBe(1);
  });
});

describe("the integer rule", () => {
  const cfg = config({
    kind: "number",
    constraints: { integer: true },
    matchers: [{ kind: "number", value: 4, tolerance: 1 }],
  } as Partial<ShortConfig>);

  it("accepts a whole number inside the tolerance", () => {
    expect(gradedNow(cfg, "5", 2).points).toBe(2);
  });

  it("refuses a non-integer answer, tolerance or not", () => {
    const result = gradedNow(cfg, "4.5", 2);
    expect(result.points).toBe(0);
    expect(result.details.matchedIndex).toBeNull();
  });

  it("leaves a plain number question alone", () => {
    const loose = config({
      kind: "number",
      matchers: [{ kind: "number", value: 4, tolerance: 1 }],
    } as Partial<ShortConfig>);
    expect(gradedNow(loose, "4,5", 2).points).toBe(2);
  });
});

describe("the empty answer", () => {
  it("scores 0 when it is null (F-GRADE-01)", () => {
    const result = gradedNow(config(), null, 5);
    expect(result.points).toBe(0);
    expect(result.details.matchedIndex).toBeNull();
  });

  it("scores 0 when it is blank, without running a matcher that would accept it", () => {
    const cfg = config({ matchers: [{ kind: "regex", pattern: ".*" }] } as Partial<ShortConfig>);
    expect(gradedNow(cfg, "   ", 5).points).toBe(0);
  });
});

describe("the result", () => {
  it("is born validated and rounded to two decimals", () => {
    const cfg = config({
      matchers: [{ kind: "exact", value: "a", points: 0.33 }],
    } as Partial<ShortConfig>);
    const result = gradedNow(cfg, "a", 3);
    expect(result.state).toBe("validated");
    expect(result.points).toBe(0.99);
  });

  it("validates against detailsSchema, and carries the normalised answer", () => {
    const result = gradedNow(config(), "  #include   <stdio.h>  ", 1);
    expect(shortServer.detailsSchema.safeParse(result.details).success).toBe(true);
    expect(result.details.normalized).toBe("#include <stdio.h>");
  });

  it("never lets an llm matcher decide anything in the MVP", () => {
    const cfg = config({
      matchers: [{ kind: "llm", rubric: "anything goes" }],
    } as Partial<ShortConfig>);
    expect(gradedNow(cfg, "a brilliant essay", 6).points).toBe(0);
  });
});
