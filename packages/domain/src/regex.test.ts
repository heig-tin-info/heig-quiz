/**
 * The bounds of the regex engine (`regex.ts`, ADR-099, security audit H3):
 * linear matching, the refusals, the estimate read before any build — one
 * pattern's and one question's — and the weight of what the cache keeps.
 */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildClock,
  CACHE_WEIGHT_LIMIT,
  CONFIG_BUILD_MS,
  configPatternProblems,
  MAX_PATTERN_LENGTH,
  MAX_PROGRAM_SIZE,
  PATTERN_WEIGHT_LIMIT,
  patternProblem,
  SINGLE_BUILD_MS,
  testPattern,
} from "./regex.js";

/*
 * Coverage, always on in this package, slows a build some twentyfold: the
 * measured guards would refuse here what they accept in production. The
 * clock they read is therefore stopped for this file, and the guards are
 * tested on their own with a clock that runs as fast as they need.
 */
const realNow = buildClock.now;
beforeAll(() => {
  buildClock.now = () => 0;
});
afterAll(() => {
  buildClock.now = realNow;
});

/**
 * Milliseconds a call takes: the best of three, so that a busy machine (the
 * full suite, coverage) does not fail a bound a backtracking engine would
 * miss by seconds anyway.
 */
function elapsed(call: () => unknown): number {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    call();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/**
 * A pattern no other call compiled, so that its build is measured, not the
 * cache. An optional group at the end keeps a one-pass program one-pass.
 */
let fresh = 0;
const unseen = (pattern: string) => `(?:${pattern})(?:unseen${fresh++})?`;

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
    expect(elapsed(() => expect(patternProblem(unseen(wide.repeat(20)), "i")).toBe("too_complex"))).toBeLessThan(50);
    expect(patternProblem(unseen(`(?i)${wide}`), "")).toBe("too_complex");
    expect(patternProblem(unseen(`(?mi:${wide})`), "")).toBe("too_complex");
    // Without folding the same range is one cheap class.
    expect(patternProblem(unseen(wide), "")).toBeNull();
    // A range that covers the whole folding window is not walked either.
    expect(patternProblem(unseen("[\\x{0}-\\x{10FFFF}]+"), "i")).toBeNull();
    // An alphabet is a few hundred code points: Latin Extended, Cyrillic.
    expect(patternProblem(unseen("[Ā-ɏЀ-ӿ]+"), "i")).toBeNull();
  });

  it("counts each Unicode property at its cost, inside and outside brackets", () => {
    // Under `i` each `\p{Ll}` merges its table with the folding table, some
    // 0.2 ms; ten are the most one pattern may build.
    expect(patternProblem(unseen("\\p{Ll}".repeat(10)), "i")).toBeNull();
    expect(elapsed(() => expect(patternProblem(unseen("\\p{Ll}".repeat(11)), "i")).toBe("too_complex"))).toBeLessThan(50);
    expect(patternProblem(unseen("[\\p{L}\\p{N}]".repeat(6)), "i")).toBe("too_complex");
    expect(patternProblem(unseen("\\P{Lu}\\p{^L}".repeat(6)), "i")).toBe("too_complex");
    // A repetition copies a property into every state of the one-pass matcher.
    expect(patternProblem(unseen("\\PL{480}"), "i")).toBe("too_complex");
    expect(patternProblem(unseen("\\p{L}{1,50}"), "i")).toBeNull();
    expect(patternProblem(unseen("\\p{L}{1,51}"), "i")).toBe("too_complex");
  });

  it("counts the ranges of any class its repetitions copy, not only the properties", () => {
    // 260 separate ranges, copied 480 times into the one-pass matcher: about 3 ms built.
    const wide = `[${Array.from({ length: 260 }, (_, j) => String.fromCodePoint(0x100 + j * 2)).join("")}]`;
    expect(elapsed(() => expect(patternProblem(unseen(`${wide}{480}`), "")).toBe("too_complex"))).toBeLessThan(50);
    expect(patternProblem(unseen(`${wide}{20}`), "")).toBeNull();
    expect(patternProblem(unseen("[a-z\\d[:alpha:]]{1,100}"), "")).toBeNull();
  });

  it("refuses a large program before building it", () => {
    // Built, these 30 thousand copies of `\pL` took some 400 MB of heap.
    expect(elapsed(() => expect(patternProblem(unseen("\\pL{1000}".repeat(30)))).toBe("too_complex"))).toBeLessThan(50);
    expect(elapsed(() => expect(patternProblem(unseen("a{1000}".repeat(30)))).toBe("too_complex"))).toBeLessThan(50);
    expect(patternProblem(unseen("((a{10}){10}){10}"))).toBe("too_complex");
  });

  it("builds the slowest pattern it accepts", () => {
    // About 2 ms; coverage, always on in this package, slows it some twentyfold.
    expect(elapsed(() => expect(patternProblem(unseen("\\p{Ll}".repeat(10)), "i")).toBeNull())).toBeLessThan(100);
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

describe("what one question may cost, read before any build", () => {
  const blanks = (count: number, pattern: string) =>
    Array.from({ length: count }, () => ({ pattern: unseen(pattern), flags: "i" }));

  it("refuses fifty costly patterns together, each acceptable alone, building none", () => {
    const costly = blanks(50, "\\p{Ll}".repeat(10));
    expect(elapsed(() => expect(configPatternProblems(costly)).toBe("too_costly"))).toBeLessThan(20);
  });

  it("checks a question under the budget, each pattern on its own", () => {
    // About 25 ms at the budget; under coverage some twentyfold
    // (`qt-cloze/src/server.test.ts` holds the tight bound).
    expect(
      elapsed(() => {
        const problems = configPatternProblems([...blanks(5, "\\p{Ll}".repeat(10)), ...blanks(45, "(the )?[a-zà-ÿ]{2,30}")]);
        expect(problems).toEqual(Array(50).fill(null));
      }),
    ).toBeLessThan(1000);
    expect(configPatternProblems([{ pattern: "(a)\\1", flags: "i" }, { pattern: "a", flags: "g" }])).toEqual([
      "unsupported",
      "flags",
    ]);
  });
});

describe("the measured build time, whatever the estimate missed", () => {
  /** A clock that moves `step` milliseconds each time it is read. */
  function steppingClock(step: number): () => void {
    let now = 0;
    buildClock.now = () => (now += step);
    return () => {
      buildClock.now = () => 0;
    };
  }

  it("refuses a pattern whose build took too long, and never builds it again", () => {
    const stop = steppingClock(SINGLE_BUILD_MS + 1);
    const pattern = unseen("cheap");
    try {
      expect(patternProblem(pattern)).toBe("too_complex");
    } finally {
      stop();
    }
    // Cached: the clock stopped, the refusal stays.
    expect(patternProblem(pattern)).toBe("too_complex");
    expect(testPattern("cheap", pattern, "i")).toBe(false);
  });

  it("stops building a question's patterns once their builds took the budget", () => {
    // Each build reads as 2 × step, each pattern of the question as 3 × step.
    const step = Math.floor(SINGLE_BUILD_MS / 2) - 1;
    const stop = steppingClock(step);
    const fits = Math.floor(CONFIG_BUILD_MS / (3 * step));
    try {
      const patterns = Array.from({ length: fits + 2 }, () => ({ pattern: unseen("cheap"), flags: "i" }));
      expect(configPatternProblems(patterns)).toBe("too_costly");
      expect(configPatternProblems(patterns.slice(0, fits))).toEqual(Array(fits).fill(null));
    } finally {
      stop();
    }
  });
});

describe("what the cache keeps", () => {
  it("weighs each program by the classes it holds and its one-pass matcher", () => {
    // The weight is read inside re2js (pinned): `\p{L}{1,50}` is one-pass,
    // fifty copies of `\pL`, too heavy to keep, so that matcher is dropped
    // and the pattern stays accepted, matching all the same.
    expect(patternProblem(unseen("\\p{L}{1,50}"))).toBeNull();
    expect(testPattern("Ωμέγα", "\\p{L}{1,50}", "i")).toBe(true);
    expect(testPattern("a".repeat(51), "\\p{L}{1,50}", "i")).toBe(false);
    // Ten written-out `\p{^L}` are ten tables: past the weight of one pattern.
    expect(patternProblem(unseen("\\p{^L}".repeat(10)), "i")).toBe("too_complex");
    expect(patternProblem(unseen(".".repeat(10)), "i")).toBeNull();
  });

  /** The largest `count` for which `make(count)` is accepted. */
  function heaviestAccepted(make: (count: number) => string): string {
    for (let count = 100; count > 0; count--) {
      if (patternProblem(make(count), "i") === null) return make(count);
    }
    throw new Error("no count accepted");
  }

  it("holds less than its limit when filled with the heaviest patterns it accepts", { timeout: 60_000 }, () => {
    setFlagsFromString("--expose_gc");
    const gc = runInNewContext("gc") as () => void;
    // Written-out properties, negated ones, a one-pass repetition.
    const heavy = [
      heaviestAccepted((count) => "\\P{Lu}".repeat(count)),
      heaviestAccepted((count) => "\\p{^L}".repeat(count)),
      heaviestAccepted((count) => `\\PL{${count}}`),
      // An alternation of literals: re2js's prefilter (dropped) and one-pass tables.
      heaviestAccepted((count) => `(?:ab|cd){${count}}`),
      heaviestAccepted((count) => `(?:abcdefgh|ijklmnop){${count}}`),
    ];
    gc();
    const before = process.memoryUsage().heapUsed;
    // Three times what the cache may hold, at the most one pattern weighs.
    for (let i = 0; i < Math.ceil((3 * CACHE_WEIGHT_LIMIT) / PATTERN_WEIGHT_LIMIT); i++) {
      expect(testPattern("abc", unseen(heavy[i % heavy.length]!), "i")).toBe(false);
    }
    gc();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(CACHE_WEIGHT_LIMIT * 0.8);
  });
});
