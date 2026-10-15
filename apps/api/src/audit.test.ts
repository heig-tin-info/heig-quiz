import { describe, expect, it } from "vitest";

import { RecentReads } from "./audit.js";

describe("RecentReads (#875)", () => {
  it("claims a key once per window, and again once the window has passed", () => {
    const reads = new RecentReads(1_000);
    expect(reads.claim("a", 0)).toBe(true);
    expect(reads.claim("a", 999)).toBe(false);
    expect(reads.claim("b", 500)).toBe(true);
    expect(reads.claim("a", 1_000)).toBe(true);
    expect(reads.claim("a", 1_500)).toBe(false);
  });

  it("forgets the expired keys, so it holds only the keys of one window", () => {
    const reads = new RecentReads(1_000);
    for (let i = 0; i < 100; i++) reads.claim(`k${i}`, i);
    expect(reads.size).toBe(100);
    reads.claim("late", 1_050);
    // k0..k50 expired; k51..k99 and `late` remain.
    expect(reads.size).toBe(50);
    reads.claim("later", 5_000);
    expect(reads.size).toBe(1);
  });

  it("gives a key back when its entry could not be written", () => {
    const reads = new RecentReads(1_000);
    expect(reads.claim("a", 0)).toBe(true);
    reads.release("a");
    expect(reads.claim("a", 10)).toBe(true);
  });
});
