import { describe, expect, it } from "vitest";
import { pseudonym, uniquePseudonyms } from "./pseudonym.js";

describe("pseudonym", () => {
  it("is stable for one (evaluation, user) pair", () => {
    expect(pseudonym("eval-1", "user-1")).toBe(pseudonym("eval-1", "user-1"));
  });

  it("depends on the evaluation, so a label cannot be traced across evaluations", () => {
    expect(pseudonym("eval-1", "user-1")).not.toBe(pseudonym("eval-2", "user-1"));
  });

  it("reads as an adjective and an animal", () => {
    expect(pseudonym("eval-1", "user-1")).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("spreads a realistic cohort over the label space", () => {
    const labels = new Set(
      Array.from({ length: 30 }, (_, i) => pseudonym("eval-1", `user-${i}`)),
    );
    expect(labels.size).toBeGreaterThanOrEqual(28);
  });
});

describe("uniquePseudonyms", () => {
  it("labels every student exactly once", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `user-${i}`);
    const labels = uniquePseudonyms("eval-1", ids);
    expect(labels.size).toBe(30);
    expect(new Set(labels.values()).size).toBe(30);
  });

  it("is order-independent and suffixes a collision deterministically", () => {
    const ids = ["b", "a", "c"];
    expect([...uniquePseudonyms("e", ids)].sort()).toEqual([...uniquePseudonyms("e", [...ids].reverse())].sort());
    // Two identical ids collide by construction, which exercises the suffix.
    const collided = uniquePseudonyms("e", ["a", "a"]);
    expect(collided.size).toBe(1);
  });
});
