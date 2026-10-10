/**
 * The bounds of the regex engine (`regex.ts`, ADR-099, security audit H3):
 * linear matching, the refusals, the estimate read before any build, the
 * weight of what the cache keeps.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  CACHE_WEIGHT_LIMIT,
  MAX_PATTERN_LENGTH,
  MAX_PROGRAM_SIZE,
  PATTERN_WEIGHT_LIMIT,
  patternProblem,
  testPattern,
} from "./regex.js";

/**
 * Milliseconds a call takes: the best of three, so that a busy machine (the
 * full suite, coverage) does not fail a bound a backtracking engine would
 * miss by seconds anyway. `call` gets the run's number, for a test that must
 * not be served from the cache.
 */
function elapsed(call: (run: number) => unknown): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    call(run);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** A pattern no other test compiled, so that its cost is measured, not the cache's. */
let fresh = 0;
const unseen = (pattern: string) => `${pattern}|unseen${fresh++}`;

describe("linear matching", () => {
  it("matches a catastrophic-backtracking pattern in linear time", () => {
    // Exponential for a backtracking engine on a near miss; RE2 answers at
    // once, on ten times the D10 input.
    const nearMiss = `${"a".repeat(5000)}!`;
    for (const pattern of ["(a+)+$", "(a|a)*", "(a|aa)+", "(\\w+\\s?)+$"]) {
      expect(elapsed(() => expect(testPattern(nearMiss, pattern, "")).toBe(false))).toBeLessThan(100);
    }
  });

  it("keeps the worst program it accepts cheap on the longest input", () => {
    const atBound = `(?:.?){${(MAX_PROGRAM_SIZE - 4) / 2}}`;
    expect(patternProblem(atBound)).toBeNull();
    expect(elapsed(() => testPattern("a".repeat(500), atBound, "i"))).toBeLessThan(100);
  });
});

describe("refusals", () => {
  it("tells JavaScript-only syntax from a syntax error", () => {
    for (const pattern of ["(a)\\1", "a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b", "(?<n>a)\\k<n>", "\\u00e9"]) {
      expect(patternProblem(pattern)).toBe("unsupported");
      expect(testPattern("aa", pattern, "i")).toBe(false);
    }
    expect(patternProblem("([a-")).toBe("syntax");
  });

  it("applies the D10 limits", () => {
    expect(patternProblem("a".repeat(MAX_PATTERN_LENGTH + 1))).toBe("too_long");
    expect(patternProblem("a", "g")).toBe("flags");
    expect(patternProblem("a", "ii")).toBe("flags");
    expect(patternProblem("a", "imsu")).toBeNull();
  });

  it("bounds the program at its exact size", () => {
    // `(?:.?){n}` compiles to 2n + 4 instructions: right at the bound, and one past it.
    expect(patternProblem(`(?:.?){${(MAX_PROGRAM_SIZE - 4) / 2}}`)).toBeNull();
    expect(patternProblem(`(?:.?){${(MAX_PROGRAM_SIZE - 4) / 2 + 1}}`)).toBe("too_complex");
    expect(patternProblem(".{0,100}")).toBeNull();
  });
});

describe("what a build may cost, read before the build", () => {
  it("refuses a range case folding would walk code point by code point", () => {
    const wide = "[Ā-\u{10FFFF}]";
    // Built under `i`, each copy took some 35 ms; fifty of them, nearly two seconds.
    expect(elapsed((run) => expect(patternProblem(unseen(wide.repeat(20)) + run, "i")).toBe("too_complex"))).toBeLessThan(50);
    expect(patternProblem(unseen(`(?i)${wide}`), "")).toBe("too_complex");
    expect(patternProblem(unseen(`(?mi:${wide})`), "")).toBe("too_complex");
    // Without folding the same range is one cheap class.
    expect(patternProblem(unseen(wide), "")).toBeNull();
    // A range that covers the whole folding window is not walked either.
    expect(patternProblem(unseen("[\\x{0}-\\x{10FFFF}]+"), "i")).toBeNull();
    // An alphabet is a few hundred code points: Latin Extended, Cyrillic.
    expect(patternProblem(unseen("[Ā-ɏЀ-ӿ]+"), "i")).toBeNull();
  });

  it("refuses a program of Unicode classes before building it", () => {
    // Built, these 30 thousand copies of `\pL` took some 400 MB of heap.
    expect(elapsed((run) => expect(patternProblem(unseen("\\pL{1000}".repeat(30)) + run)).toBe("too_complex"))).toBeLessThan(50);
    expect(elapsed((run) => expect(patternProblem(unseen("a{1000}".repeat(30)) + run)).toBe("too_complex"))).toBeLessThan(50);
    expect(patternProblem(unseen("((a{10}){10}){10}"))).toBe("too_complex");
    expect(patternProblem(unseen("\\p{L}{1,50}"))).toBeNull();
  });

  it("reads the estimate through escapes, classes and groups", () => {
    expect(patternProblem(unseen("\\Q[a-z]{9999}\\E"))).toBeNull();
    expect(patternProblem(unseen("(?P<word>\\w+) (?<other>[[:alpha:]]+)"))).toBeNull();
    expect(patternProblem(unseen("[\\x{41}-\\x{5A}\\101-\\132\\n\\]-]+"))).toBeNull();
    expect(patternProblem(unseen("[]a]"))).toBeNull();
    expect(patternProblem(unseen("[^\\x41-\\x5A]{2,}"))).toBeNull();
    expect(patternProblem(unseen("a{2"))).toBeNull();
    expect(patternProblem(unseen("(a|b)"))).toBeNull();
    expect(patternProblem("(a")).toBe("syntax");
    expect(patternProblem("\\")).toBe("syntax");
    expect(patternProblem("[a")).toBe("syntax");
    expect(patternProblem(unseen("[\\pN\\x{1F600}-\\x{1F64F}\\d]"))).toBeNull();
  });
});

describe("what the cache keeps", () => {
  it("weighs each program by the classes it holds, and refuses one too heavy to keep", () => {
    // Fewer than 500 instructions either way: only the weight of the classes
    // (read inside re2js, pinned) tells the two apart.
    expect(patternProblem(unseen("\\pL".repeat(60)))).toBeNull();
    expect(patternProblem(unseen("\\pL".repeat(70)))).toBe("too_complex");
    expect(patternProblem(unseen(".".repeat(70)))).toBeNull();
    // A repetition shares its class: one `\pL`, kept once.
    expect(patternProblem("\\p{L}{490}")).toBeNull();
  });

  it("holds at most about 48 MB, filled with the heaviest pattern it accepts", () => {
    setFlagsFromString("--expose_gc");
    const gc = runInNewContext("gc") as () => void;
    const heavy = "\\pL".repeat(60);
    expect(patternProblem(unseen(heavy))).toBeNull();
    gc();
    const before = process.memoryUsage().heapUsed;
    // Nearly PATTERN_WEIGHT_LIMIT each: a fifth more than the cache may hold.
    for (let i = 0; i < Math.ceil((1.2 * CACHE_WEIGHT_LIMIT) / PATTERN_WEIGHT_LIMIT); i++) {
      expect(testPattern("abc", unseen(heavy), "i")).toBe(false);
    }
    gc();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(60 * 1024 * 1024);
  });
});
