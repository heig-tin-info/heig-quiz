/**
 * The reads of the grading grid: the standing gradings, the progress, the
 * cell a route addresses and the points of each attempt.
 */
import { and, asc, eq, inArray, ne } from "drizzle-orm";

import type { Grading, GradingProgress, Verdict } from "@quiz/contracts";
import { reasonOf, RUNNER_WAITING_REASONS } from "@quiz/contracts";
import { countsForStudent, outcomeOf } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { answers, attempts, gradings, officialAttempt } from "../../db/schema.js";
import { joinedItem, joinedItems, type JoinedItem } from "../evaluation/service.js";
import { tallyByAttempt } from "./kept.js";
import { pairKey, type GradingRecord, type PairKey } from "./records.js";

// --- Reads ----------------------------------------------------------------

export const toGrading = (row: GradingRecord): Grading => ({
  id: row.id,
  answerId: row.answerId,
  attemptId: row.attemptId,
  itemId: row.itemId,
  points: row.points,
  maxPoints: row.maxPoints,
  source: row.source,
  state: row.state,
  details: row.details ?? null,
  confidence: row.confidence,
  comment: row.comment,
  gradedBy: row.gradedBy,
  gradedAt: iso(row.gradedAt),
  supersedesId: row.supersedesId,
  regradeNote: row.regradeNote,
});

/** The verdict a grid cell shows (F-DASH-01, F-RES-04). */
export function verdictOf(row: Pick<GradingRecord, "points" | "maxPoints" | "state">): Verdict {
  if (row.state === "proposed") return "pending";
  return outcomeOf(row.points, row.maxPoints);
}

/** The cells of an evaluation a read is about: all of them, or one item's. */
export interface CellScope {
  itemId?: string | undefined;
  /**
   * These attempts' cells, whatever they are: what a grading pass reads of
   * the attempts it grades, a practice one after the due date included
   * (ADR-122). Without it, the official attempts only — every reader of the
   * class (the panel, the results, the progress) leaves practice out.
   */
  attemptIds?: readonly string[] | undefined;
}

/** The `WHERE` of a {@link CellScope} on `gradings` joined to its attempts. */
export const gradingsIn = (evaluationId: string, scope: CellScope) =>
  and(
    eq(attempts.evaluationId, evaluationId),
    scope.attemptIds ? inArray(attempts.id, [...scope.attemptIds]) : officialAttempt,
    scope.itemId ? eq(gradings.itemId, scope.itemId) : undefined,
  );

/**
 * Every grading of an evaluation that is still standing (`validated` or
 * `proposed`), keyed by cell. One query: the dashboard, the results and the
 * panel all need the same map and none of them may issue a query per cell.
 * The panel narrowed to one item reads only that item's cells.
 */
export async function standingGradings(
  db: Db,
  evaluationId: string,
  scope: CellScope = {},
): Promise<Map<PairKey, GradingRecord>> {
  const rows = await db
    .select({ grading: gradings })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(and(gradingsIn(evaluationId, scope), ne(gradings.state, "superseded")))
    .orderBy(asc(gradings.gradedAt));
  const map = new Map<PairKey, GradingRecord>();
  for (const row of rows) {
    const key = pairKey(row.grading.attemptId, row.grading.itemId);
    const current = map.get(key);
    // A validated grading always outranks a proposal on the same cell.
    if (!current || current.state !== "validated") map.set(key, row.grading);
  }
  return map;
}

/** The validated half, which is the only one that counts towards a grade. */
export async function validatedGradings(
  db: Db,
  evaluationId: string,
): Promise<Map<PairKey, GradingRecord>> {
  const standing = await standingGradings(db, evaluationId);
  const map = new Map<PairKey, GradingRecord>();
  for (const [key, row] of standing) if (row.state === "validated") map.set(key, row);
  return map;
}

/** `GET /evaluations/:id/grading/progress`. */
export async function progressOf(db: Db, evaluationId: string): Promise<GradingProgress> {
  const items = await joinedItems(db, evaluationId);
  const attemptRows = await db
    .select({ id: attempts.id })
    .from(attempts)
    // A practice attempt (ADR-122) awaits no teacher.
    .where(and(eq(attempts.evaluationId, evaluationId), officialAttempt));
  // A neutralized item (ADR-108) awaits no grade: neither in the total nor done.
  const counted = new Set(items.filter((i) => countsForStudent(i.item.counting)).map((i) => i.item.id));
  const total = counted.size * attemptRows.length;
  const standing = await standingGradings(db, evaluationId);

  let done = 0;
  let runner = 0;
  let llm = 0;
  let failed = 0;
  for (const row of standing.values()) {
    if (!counted.has(row.itemId)) continue;
    if (row.state === "validated") {
      done += 1;
      continue;
    }
    const reason = reasonOf(row.details);
    if (reason === "llm_not_configured") llm += 1;
    else if ((RUNNER_WAITING_REASONS as readonly (string | null)[]).includes(reason)) runner += 1;
    else failed += 1;
  }
  return { done, total, pending: { runner, llm }, failed };
}

/**
 * The cell a route addresses by `answerId`, with the item's point scale. An
 * answer nobody can reach is `null`, and the route answers 404 (invariant 6).
 */
export async function cellOfAnswer(
  db: Db,
  answerId: string,
): Promise<{
  evaluationId: string;
  attemptId: string;
  itemId: string;
  answerId: string;
  maxPoints: number;
  /** The item, for its range and its criteria (ADR-118 §6). */
  item: JoinedItem;
} | null> {
  const [row] = await db
    .select({
      attemptId: answers.attemptId,
      itemId: answers.itemId,
      evaluationId: attempts.evaluationId,
    })
    .from(answers)
    .innerJoin(attempts, eq(answers.attemptId, attempts.id))
    .where(eq(answers.id, answerId))
    .limit(1);
  if (!row) return null;
  const item = await joinedItem(db, row.evaluationId, row.itemId);
  if (!item) return null;
  return {
    evaluationId: row.evaluationId,
    attemptId: row.attemptId,
    itemId: row.itemId,
    answerId,
    maxPoints: item.item.points,
    item,
  };
}

/**
 * The TOTAL of each attempt — the validated points summed and floored at 0
 * (`attemptTotal`, ADR-026) — in one query. The same numbers as
 * {@link tallyByAttempt}, of which it is the points half.
 */
export async function pointsByAttempt(
  db: Db,
  attemptIds: readonly string[],
): Promise<Map<string, number>> {
  const tallies = await tallyByAttempt(db, attemptIds);
  return new Map([...tallies].map(([id, tally]) => [id, tally.points]));
}
