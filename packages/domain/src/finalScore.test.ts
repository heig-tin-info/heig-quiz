import { describe, expect, it } from "vitest";

import { finalPoints, resolveFinalScore } from "./finalScore.js";

const s = (points: number | null, max: number | null = 6, parseStatus = "ok") => ({
  points,
  max,
  parseStatus,
});

describe("resolveFinalScore", () => {
  it("prefers the teacher's adjustment over everything", () => {
    expect(
      resolveFinalScore({ teacherPoints: 5.5, llmScore: s(4), frozenScore: s(3) }),
    ).toEqual({ points: 5.5, max: 6, source: "teacher" });
  });

  it("keeps a teacher's zero (not a missing score)", () => {
    expect(resolveFinalScore({ teacherPoints: 0, llmScore: s(4) })).toEqual({
      points: 0,
      max: 6,
      source: "teacher",
    });
  });

  it("takes the CI scale for an override when there is no LLM review, none at all without scores", () => {
    expect(resolveFinalScore({ teacherPoints: 7, score: s(3, 10) })).toEqual({
      points: 7,
      max: 10,
      source: "teacher",
    });
    expect(resolveFinalScore({ teacherPoints: 4 })).toEqual({ points: 4, max: null, source: "teacher" });
  });

  it("falls back to the LLM review", () => {
    expect(resolveFinalScore({ teacherPoints: null, llmScore: s(4), frozenScore: s(3) })).toEqual({
      points: 4,
      max: 6,
      source: "llm",
    });
  });

  it("falls back to the frozen CI score", () => {
    expect(resolveFinalScore({ frozenScore: s(3), score: s(2) })).toEqual({
      points: 3,
      max: 6,
      source: "ci",
    });
  });

  it("uses the current CI score while nothing is frozen", () => {
    expect(resolveFinalScore({ score: s(2) })).toEqual({ points: 2, max: 6, source: "ci" });
  });

  it("ignores scores whose annotation did not parse", () => {
    expect(resolveFinalScore({ llmScore: s(null, null, "no_annotation"), score: s(2) })).toEqual({
      points: 2,
      max: 6,
      source: "ci",
    });
    expect(resolveFinalScore({ frozenScore: s(null, null, "malformed") })).toBeNull();
  });

  it("returns null when the student has no score at all", () => {
    expect(resolveFinalScore({})).toBeNull();
    expect(finalPoints({ teacherPoints: null, llmScore: null, score: null })).toBeNull();
  });

  it("finalPoints exposes the points only", () => {
    expect(finalPoints({ llmScore: s(4.5) })).toBe(4.5);
  });
});
