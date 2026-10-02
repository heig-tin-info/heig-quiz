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
  /** The final review's score (the `review` slot). */
  reviewScore?: ScoreLike | null;
  /** CI score frozen at the deadline. */
  frozenScore?: ScoreLike | null;
  /** Current CI score, fallback while nothing is frozen. */
  score?: ScoreLike | null;
}

export interface FinalScore {
  points: number;
  /** Scale of the score the points come from; null when only an override exists. */
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
    return { points: repo.teacherPoints, max: review?.max ?? ci?.max ?? null, source: "teacher" };
  }
  if (review) return { points: review.points, max: review.max, source: "review" };
  if (ci) return { points: ci.points, max: ci.max, source: "ci" };
  return null;
}

/** Final points alone (exports, sorting); null when the student has no score. */
export function finalPoints(repo: FinalScoreInput): number | null {
  return resolveFinalScore(repo)?.points ?? null;
}
