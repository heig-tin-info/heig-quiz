/**
 * Final score of a student's project repository (F-PROJ-14, ported from
 * heig-classroom's `finalGrade.ts`): the teacher's score wins, else the
 * final review's (the `review` slot, heig-classroom's "LLM"), else the
 * frozen CI score — and, while nothing is frozen yet, the current CI score.
 *
 * Single source of truth: every view and export of a project's scores
 * resolves through this function. Only scores whose annotation parsed (`ok`)
 * count; a malformed or missing GRADE annotation is not a score. How a score
 * becomes a Swiss grade, and when a student sees it, is D05
 * (`docs/merge/08-decisions.md`), not this function.
 */

/** Where a final score comes from (I42: the gradebook names it). */
export const FINAL_SCORE_SOURCES = ["teacher", "review", "ci"] as const;
export type FinalScoreSource = (typeof FINAL_SCORE_SOURCES)[number];

/** Structural shape of a score view or of a score run row. */
export interface ScoreLike {
  points: number | null;
  max: number | null;
  parseStatus: string;
}

export interface FinalScoreInput {
  /** Teacher override (points on the project's scale); null = none. */
  teacherPoints?: number | null;
  /**
   * The maximum the teacher's points were written with (M3-08b): the scored
   * run's when the repository had one, the teacher's own otherwise. Null on
   * heig-classroom's imported rows, which read the CI's maximum.
   */
  teacherMax?: number | null;
  /** The final review's score (the `review` slot). */
  reviewScore?: ScoreLike | null;
  /** CI score frozen at the deadline. */
  frozenScore?: ScoreLike | null;
  /** Current CI score, fallback while nothing is frozen. */
  score?: ScoreLike | null;
}

export interface FinalScore {
  points: number;
  /** Scale of the score the points come from; null only for an imported override without a scored run. */
  max: number | null;
  source: FinalScoreSource;
}

function parsed(s: ScoreLike | null | undefined): (ScoreLike & { points: number }) | null {
  return s != null && s.parseStatus === "ok" && s.points != null ? { ...s, points: s.points } : null;
}

/** Resolves the final score, or null when the student has none. */
export function resolveFinalScore(repo: FinalScoreInput): FinalScore | null {
  const review = parsed(repo.reviewScore);
  const ci = parsed(repo.frozenScore) ?? parsed(repo.score);
  if (repo.teacherPoints != null) {
    return { points: repo.teacherPoints, max: repo.teacherMax ?? review?.max ?? ci?.max ?? null, source: "teacher" };
  }
  if (review) return { points: review.points, max: review.max, source: "review" };
  if (ci) return { points: ci.points, max: ci.max, source: "ci" };
  return null;
}

/** Why a teacher's score is refused (`422`): the codes of `ProjectErrorCode`. */
export type TeacherScoreRefusal = "score_max_required" | "score_max_mismatch" | "score_above_max";

/**
 * The maximum a teacher's score is written with (product owner, 2026-10-02,
 * merge task M3-08b): the scored run's — the one the final score would
 * otherwise come from, `runMax` — when the repository has one, and a `given`
 * maximum must then equal it; the teacher's own, required, when it has none
 * (pass / fail only, malformed, multiple). The points never exceed it.
 */
export function teacherScoreMax(
  points: number,
  given: number | undefined,
  runMax: number | null,
): { max: number } | { refusal: TeacherScoreRefusal } {
  if (runMax === null && given === undefined) return { refusal: "score_max_required" };
  if (runMax !== null && given !== undefined && given !== runMax) return { refusal: "score_max_mismatch" };
  const max = runMax ?? given!;
  return points > max ? { refusal: "score_above_max" } : { max };
}

/** Final points alone (exports, sorting); null when the student has no score. */
export function finalPoints(repo: FinalScoreInput): number | null {
  return resolveFinalScore(repo)?.points ?? null;
}
