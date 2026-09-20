import { describe, expect, it } from "vitest";
import { hashSeed, pick, rng, seededShuffle, shuffle, streamSeed } from "./rng.js";

/**
 * GOLDEN TABLE. These numbers are the contract, not an implementation detail:
 * a stored attempt seed must reproduce the same question order and the same
 * choice order on every machine, in every browser, forever. If a change makes
 * this table fail, the change is wrong — every attempt already taken would be
 * replayed differently in the grading panel.
 */
const GOLDEN_HASH: [parts: (string | number)[], hash: number][] = [
  [[""], 1779010670],
  [["abc"], 50696492],
  [[42, "item-1", "choices"], 940111534],
];

const GOLDEN_SHUFFLE_12: [seed: number, out: number[]][] = [
  [0, [9, 10, 4, 8, 5, 6, 7, 11, 1, 2, 0, 3]],
  [1, [4, 10, 2, 6, 9, 3, 1, 11, 8, 5, 0, 7]],
  [42, [2, 0, 5, 10, 9, 11, 3, 1, 6, 8, 4, 7]],
  [123456789, [6, 9, 11, 0, 8, 4, 5, 2, 1, 7, 10, 3]],
  [2147483647, [2, 8, 7, 10, 11, 4, 6, 0, 9, 3, 1, 5]],
];

const TWELVE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

describe("hashSeed", () => {
  it("matches the golden table", () => {
    for (const [parts, expected] of GOLDEN_HASH) expect(hashSeed(...parts)).toBe(expected);
  });

  it("returns an unsigned 32-bit integer", () => {
    for (let i = 0; i < 200; i++) {
      const h = hashSeed("x", i);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("separates the parts, so ('ab','c') and ('a','bc') differ", () => {
    expect(hashSeed("ab", "c")).not.toBe(hashSeed("a", "bc"));
  });
});

describe("rng", () => {
  it("stays inside [0,1) and is reproducible", () => {
    const a = rng(12345);
    const b = rng(12345);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(b()).toBe(v);
    }
  });

  it("matches the golden first draws", () => {
    const g = rng(12345);
    expect([g(), g(), g()]).toEqual([0.9797282677609473, 0.3067522644996643, 0.484205421525985]);
  });
});

describe("shuffle", () => {
  it("matches the golden permutation table for 12 items", () => {
    for (const [seed, expected] of GOLDEN_SHUFFLE_12) {
      expect(shuffle(TWELVE, seed)).toEqual(expected);
    }
  });

  it("is a permutation and never mutates the input", () => {
    const input = Object.freeze(TWELVE.slice());
    for (let seed = 0; seed < 50; seed++) {
      const out = shuffle(input, seed);
      expect(out.slice().sort((x, y) => x - y)).toEqual(TWELVE);
      expect(input).toEqual(TWELVE);
    }
  });

  it("handles the empty and single-element cases", () => {
    expect(shuffle([], 7)).toEqual([]);
    expect(shuffle(["only"], 7)).toEqual(["only"]);
  });

  it("actually reorders: for n = 4, at most a few seeds in a hundred are the identity", () => {
    const four = [0, 1, 2, 3];
    let identical = 0;
    for (let seed = 0; seed < 100; seed++) {
      if (shuffle(four, seed).every((v, i) => v === i)) identical++;
    }
    expect(identical).toBeLessThan(10);
  });

  it("gives different permutations for different seeds", () => {
    expect(shuffle(TWELVE, 1)).not.toEqual(shuffle(TWELVE, 2));
  });

  it("is exposed under both names", () => {
    expect(seededShuffle).toBe(shuffle);
    expect(seededShuffle(TWELVE, 42)).toEqual(shuffle(TWELVE, 42));
  });
});

describe("streamSeed", () => {
  it("is hashSeed of the three parts", () => {
    expect(streamSeed(42, "item-1", "choices")).toBe(hashSeed(42, "item-1", "choices"));
    expect(streamSeed(42, "item-1", "choices")).toBe(940111534);
  });

  it("separates purposes and items", () => {
    expect(streamSeed(42, "item-1", "choices")).not.toBe(streamSeed(42, "item-1", "items"));
    expect(streamSeed(42, "item-1", "choices")).not.toBe(streamSeed(42, "item-2", "choices"));
    expect(streamSeed(42, "item-1", "options:0")).not.toBe(streamSeed(42, "item-1", "options:1"));
  });
});

describe("pick", () => {
  it("returns a member of the array, deterministically", () => {
    expect(pick(TWELVE, 99)).toBe(3);
    expect(pick(TWELVE, 1)).toBe(7);
    expect(pick(TWELVE, 99)).toBe(pick(TWELVE, 99));
  });

  it("throws on an empty array", () => {
    expect(() => pick([], 1)).toThrow(RangeError);
  });
});
