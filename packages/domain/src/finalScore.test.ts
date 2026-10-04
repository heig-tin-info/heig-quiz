import { describe, expect, it } from "vitest";

import { finalPoints, resolveFinalScore, teacherScoreMax } from "./finalScore.js";

const s = (points: number | null, max: number | null = 6, parseStatus = "ok") => ({
  points,
  max,
  parseStatus,
});

describe("resolveFinalScore", () => {
  it("prefers the teacher's adjustment over everything", () => {
    expect(
      resolveFinalScore({ teacherPoints: 5.5, reviewScore: s(4), frozenScore: s(3) }),
    ).toEqual({ points: 5.5, max: 6, source: "teacher" });
  });

  it("keeps a teacher's zero (not a missing score)", () => {
    expect(resolveFinalScore({ teacherPoints: 0, reviewScore: s(4) })).toEqual({
      points: 0,
      max: 6,
      source: "teacher",
    });
  });

  it("takes the CI scale for an override when there is no review, none at all without scores", () => {
    expect(resolveFinalScore({ teacherPoints: 7, score: s(3, 10) })).toEqual({
      points: 7,
      max: 10,
      source: "teacher",
    });
    expect(resolveFinalScore({ teacherPoints: 4 })).toEqual({ points: 4, max: null, source: "teacher" });
  });

  it("falls back to the review", () => {
    expect(resolveFinalScore({ teacherPoints: null, reviewScore: s(4), frozenScore: s(3) })).toEqual({
      points: 4,
      max: 6,
      source: "review",
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
    expect(resolveFinalScore({ reviewScore: s(null, null, "no_annotation"), score: s(2) })).toEqual({
      points: 2,
      max: 6,
      source: "ci",
    });
    expect(resolveFinalScore({ frozenScore: s(null, null, "malformed") })).toBeNull();
  });

  it("returns null when the student has no score at all", () => {
    expect(resolveFinalScore({})).toBeNull();
    expect(finalPoints({ teacherPoints: null, reviewScore: null, score: null })).toBeNull();
  });

  it("finalPoints exposes the points only", () => {
    expect(finalPoints({ reviewScore: s(4.5) })).toBe(4.5);
  });

  it("reads a teacher's score with the maximum it was written with (M3-08b)", () => {
    expect(resolveFinalScore({ teacherPoints: 7, teacherMax: 10 })).toEqual({ points: 7, max: 10, source: "teacher" });
    // Written with the run's maximum, a later run with another one never re-reads it.
    expect(resolveFinalScore({ teacherPoints: 7, teacherMax: 10, frozenScore: s(3, 20) })).toEqual({ points: 7, max: 10, source: "teacher" });
    // An imported override without its own maximum still reads the CI's.
    expect(resolveFinalScore({ teacherPoints: 7, teacherMax: null, frozenScore: s(3, 20) })).toEqual({ points: 7, max: 20, source: "teacher" });
  });
});

describe("teacherScoreMax (product owner, 2026-10-02)", () => {
  it("takes the scored run's maximum, and refuses another one", () => {
    expect(teacherScoreMax(7, undefined, 10)).toEqual({ max: 10 });
    expect(teacherScoreMax(7, 10, 10)).toEqual({ max: 10 });
    expect(teacherScoreMax(7, 12, 10)).toEqual({ refusal: "score_max_mismatch" });
  });

  it("requires the teacher's own maximum without a scored run", () => {
    expect(teacherScoreMax(7, undefined, null)).toEqual({ refusal: "score_max_required" });
    expect(teacherScoreMax(7, 12, null)).toEqual({ max: 12 });
  });

  it("keeps the points within the maximum, the maximum itself allowed", () => {
    expect(teacherScoreMax(11, undefined, 10)).toEqual({ refusal: "score_above_max" });
    expect(teacherScoreMax(10, undefined, 10)).toEqual({ max: 10 });
    expect(teacherScoreMax(13, 12, null)).toEqual({ refusal: "score_above_max" });
  });
});
