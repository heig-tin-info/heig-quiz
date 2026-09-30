/**
 * Final score of a student's project repository (ported from classroom's
 * `finalGrade.ts`): the teacher's adjustment wins,
 * else the authoritative LLM review, else the frozen CI score — and, while
 * nothing is frozen yet, the current CI score.
 *
 * Single source of truth: every view and export of a project's scores
 * resolves through this function. Only scores whose annotation parsed (`ok`)
 * count; a malformed or missing GRADE annotation is not a score. How a score
 * becomes a Swiss grade, and when a student sees it, is D05
 * (`docs/merge/08-decisions.md`), not this function.
 */

export type FinalScoreSource = "teacher" | "llm" | "ci";

/** Structural shape of a score view or of a score run row. */
export interface ScoreLike {
  points: number | null;
  max: number | null;
  parseStatus: string;
}

export interface FinalScoreInput {
  /** Teacher override (points on the project's scale); null = none. */
  teacherPoints?: number | null;
  /** Authoritative LLM review. */
  llmScore?: ScoreLike | null;
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
  const llm = parsed(repo.llmScore);
  const ci = parsed(repo.frozenScore) ?? parsed(repo.score);
  if (repo.teacherPoints != null) {
    return { points: repo.teacherPoints, max: llm?.max ?? ci?.max ?? null, source: "teacher" };
  }
  if (llm) return { points: llm.points, max: llm.max, source: "llm" };
  if (ci) return { points: ci.points, max: ci.max, source: "ci" };
  return null;
}

/** Final points alone (exports, sorting); null when the student has no score. */
export function finalPoints(repo: FinalScoreInput): number | null {
  return resolveFinalScore(repo)?.points ?? null;
}
