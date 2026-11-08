/**
 * The teacher's writes on the grid (F-GRADE-04, F-GRADE-05): an override,
 * a validation, a batch of them, and the stand-down of a reopened attempt's
 * automatic gradings (ADR-067).
 */
import { and, asc, eq, isNotNull, isNull, ne, notExists } from "drizzle-orm";

import type { GradingConfidence, GradingSource } from "@quiz/contracts";
import {
  AI_KEY,
  aiOf,
  BREAKDOWN_KEY,
  JUSTIFICATION_KEY,
  type BreakdownEntry,
  type CriterionPointsBody,
} from "@quiz/contracts";
import {
  isBatchable,
  overridePointsRange,
  round2,
  scoresNegatively,
  type DeclaredCriterion,
  validatedBreakdown,
} from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { answers, attempts, gradings, officialAttempt } from "../../db/schema.js";
import {
  joinedItems,
  negativeMarkingEnabled,
  type DbOrTx,
  type EvaluationRecord,
  type JoinedItem,
} from "../evaluation/service.js";
import { typeOf } from "../pool/config.js";
import { writtenConfig } from "../pool/service.js";
import { GradingError, NEWEST_FIRST, type GradingRecord } from "./records.js";
import { writeGrading, writeGradings, type WriteGradingInput } from "./writer.js";

// --- Teacher writes -------------------------------------------------------

/**
 * The points a teacher may give an item of type `type` in `evaluation` by
 * hand (F-GRADE-05): `[0, max]`, or `[-max, max]` for a choice question when
 * the evaluation uses negative marking (ADR-026) — never for a bonus item,
 * which is floored at 0 (ADR-052). The grading panel receives the lower
 * bound (`GradingQueueItem.minPoints`), the routes enforce both.
 */
export function pointsRangeOf(
  evaluation: EvaluationRecord,
  item: JoinedItem | null,
  maxPoints: number,
): { min: number; max: number } {
  const negative = scoresNegatively(
    item?.question.type ?? "",
    negativeMarkingEnabled(evaluation),
    item?.item.counting ?? "normal",
  );
  return overridePointsRange(maxPoints, negative);
}

/** Refuses a manual score outside {@link pointsRangeOf} with `422 points_out_of_range`. */
export function assertPointsInRange(
  evaluation: EvaluationRecord,
  item: JoinedItem | null,
  cell: { maxPoints: number },
  points: number,
): void {
  const range = pointsRangeOf(evaluation, item, cell.maxPoints);
  const value = round2(points);
  if (value < range.min || value > range.max) throw new GradingError("points_out_of_range", `the points must lie in [${range.min}, ${range.max}]`);
}

/**
 * F-GRADE-05. The comment is not optional and the previous grading is kept as
 * `superseded`: a manual correction must always be explainable afterwards.
 *
 * An essay with criteria (`target.criteria`, ADR-118 §6) is overridden
 * criterion by criterion: the total is derived from `input.criteria`, and
 * the details of the grading in force — the model's proposal, `ai` and
 * `justification` — survive beside the new breakdown. Every other item
 * writes `{ manual: true }`.
 */
export async function manualOverride(
  db: Db,
  target: {
    attemptId: string;
    itemId: string;
    answerId: string | null;
    maxPoints: number;
    /** The item's criteria ({@link criteriaOf}); none for an item graded by one total. */
    criteria: readonly DeclaredCriterion[];
  },
  input: { points?: number | undefined; criteria?: readonly CriterionPointsBody[] | undefined; comment: string },
  userId: string,
  now: Date,
): Promise<GradingRecord> {
  if (input.comment.trim().length === 0) throw new GradingError("comment_required");
  const graded = criteriaOutcome(target.criteria, target.maxPoints, input, null);
  const points = graded.points ?? input.points;
  // `ManualGradingBody` holds one of the two; a caller that sends neither is a bug.
  if (points === undefined) throw new Error("manualOverride: neither points nor criteria");
  const write: WriteGradingInput = {
    attemptId: target.attemptId,
    itemId: target.itemId,
    answerId: target.answerId,
    points,
    maxPoints: target.maxPoints,
    source: "manual",
    state: "validated",
    details: graded.breakdown ? { manual: true, [BREAKDOWN_KEY]: graded.breakdown } : { manual: true },
    comment: input.comment.trim(),
    gradedBy: userId,
    now,
  };
  if (!graded.breakdown) return writeGrading(db, write);
  // The details kept are read inside the write's transaction, the row locked
  // (`gradingInForce`): a correction of the cell committing at the same time
  // waits for this one, or this one reads after it. At worst, a correction
  // that supersedes the read row first leaves this override without the
  // proposal's `ai`; the override itself still wins (F-GRADE-05).
  const [row] = await writeGradings(db, [write], async (tx, inputs) => {
    const previous = await gradingInForce(tx, write.attemptId, write.itemId);
    return inputs.map((i) => ({ ...i, details: { ...teacherKept(previous?.details), ...(i.details as object) } }));
  });
  return row!;
}

/** What an override keeps of the details it replaces: the model's proposal, for the teacher. */
function teacherKept(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object") return {};
  const kept: Record<string, unknown> = {};
  for (const key of [AI_KEY, JUSTIFICATION_KEY]) {
    if (key in details) kept[key] = (details as Record<string, unknown>)[key];
  }
  return kept;
}

/** The newest grading of a cell that is not superseded, locked: what a correction replaces. */
async function gradingInForce(tx: Tx, attemptId: string, itemId: string): Promise<GradingRecord | null> {
  const [row] = await tx
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemId), ne(gradings.state, "superseded")))
    .orderBy(...NEWEST_FIRST)
    .limit(1)
    .for("update");
  return row ?? null;
}

/**
 * The criteria an item is graded by (ADR-118 §6): its type's
 * `gradingCriteria` of the version it holds, as written. None for a missing
 * item, a type without the hook or an essay without criteria; a config that
 * does not read throws, as every reader of it does.
 */
export function criteriaOf(item: JoinedItem | null): readonly DeclaredCriterion[] {
  const hook = item ? typeOf(item.question.type).gradingCriteria : undefined;
  return hook ? hook(writtenConfig(item!.question.type, item!.version).config) : [];
}

/**
 * What a correction makes of an item's criteria (ADR-118 §6). With
 * criteria, the teacher's `input.criteria` give the total and the breakdown
 * (`validatedBreakdown`), a bare total is refused; without the teacher's,
 * a proposal whose every criterion names one of the item's is copied into
 * the breakdown and its total kept — a free rubric or an id that matches
 * nothing gives no breakdown, never a partial one. Without criteria,
 * `input.criteria` is refused and nothing changes.
 */
function criteriaOutcome(
  declared: readonly DeclaredCriterion[],
  maxPoints: number,
  input: { points?: number | undefined; criteria?: readonly CriterionPointsBody[] | undefined },
  details: unknown,
): { points?: number; breakdown?: BreakdownEntry[] } {
  if (declared.length === 0) {
    if (input.criteria !== undefined) throw new GradingError("criteria_invalid", "this item has no criteria");
    return {};
  }
  if (input.points !== undefined) {
    throw new GradingError("criteria_invalid", "an essay with criteria is graded criterion by criterion");
  }
  if (input.criteria !== undefined) {
    const result = validatedBreakdown(declared, maxPoints, input.criteria);
    if (!result) throw new GradingError("criteria_invalid");
    return { points: result.total, breakdown: result.breakdown };
  }
  const proposed = aiOf(details)?.criteria;
  if (!proposed || proposed.some((c) => c.id === undefined)) return {};
  const result = validatedBreakdown(
    declared,
    maxPoints,
    proposed.map((c) => ({ id: c.id!, points: c.points })),
  );
  return result ? { breakdown: result.breakdown } : {};
}

/** Whether a teacher's breakdown splits the points as the proposal did, criterion by criterion. */
const sameSplit = (given: readonly BreakdownEntry[], proposed: readonly BreakdownEntry[] | undefined): boolean =>
  proposed !== undefined && given.every((line, i) => line.points === proposed[i]?.points);

type ValidationInput = {
  points?: number | undefined;
  criteria?: readonly CriterionPointsBody[] | undefined;
  comment?: string | undefined;
};

/**
 * F-GRADE-04. Validating a proposal keeps its details and its source: what
 * changes is that it now counts. Adjusting the points on the way makes it a
 * `manual` grading, because a teacher's number is not a machine's. An essay
 * with criteria (`criteria`, {@link criteriaOf}) is adjusted criterion by
 * criterion (ADR-118 §6).
 */
export async function validateGrading(
  db: Db,
  grading: GradingRecord,
  criteria: readonly DeclaredCriterion[],
  input: ValidationInput,
  userId: string,
  now: Date,
): Promise<GradingRecord> {
  return writeGrading(db, validationOf(grading, input, criteria, userId, now));
}

/**
 * The write that validates `grading`: {@link validateGrading}'s, and each of
 * {@link batchValidate}'s. The validated breakdown of an essay with criteria
 * joins the details here, whichever path validates it. A teacher's points
 * per criterion make the grading `manual` when they change the total or
 * only move points between criteria (ADR-118, amendment of 2026-10-27).
 */
function validationOf(
  grading: GradingRecord,
  input: ValidationInput,
  declared: readonly DeclaredCriterion[],
  userId: string,
  now: Date,
): WriteGradingInput {
  if (grading.state !== "proposed") throw new GradingError("not_pending");
  const graded = criteriaOutcome(declared, grading.maxPoints, input, grading.details);
  const resplit =
    input.criteria !== undefined &&
    !sameSplit(graded.breakdown!, criteriaOutcome(declared, grading.maxPoints, {}, grading.details).breakdown);
  // The proposal's own split sent back keeps the proposal's total: the sum
  // of its rounded parts may be 0.01 off (ADR-118 §3).
  const points = input.criteria !== undefined && !resplit ? grading.points : (graded.points ?? input.points ?? grading.points);
  const adjusted = round2(points) !== grading.points || resplit;
  // The proposal's details, the model's `ai` included, live on beside it.
  const details = graded.breakdown
    ? { ...(grading.details as Record<string, unknown> | null), [BREAKDOWN_KEY]: graded.breakdown }
    : grading.details;
  return {
    attemptId: grading.attemptId,
    itemId: grading.itemId,
    answerId: grading.answerId,
    points,
    maxPoints: grading.maxPoints,
    source: adjusted ? "manual" : grading.source,
    state: "validated",
    details,
    confidence: grading.confidence ?? undefined,
    comment: input.comment ?? grading.comment ?? undefined,
    gradedBy: userId,
    regradeNote: grading.regradeNote ?? undefined,
    now,
  };
}

interface BatchFilter {
  itemId?: string | undefined;
  source?: GradingSource | undefined;
  confidence?: GradingConfidence | undefined;
}

/**
 * F-GRADE-04, the "validate every high-confidence proposal of question 3"
 * button — for the proposals `isBatchable` (`@quiz/domain`) accepts. Each proposal becomes the very write a click would make
 * ({@link validationOf}), and they all go through {@link writeGradings} at
 * once — one transaction per chunk, not one per cell — so a batch leaves the
 * same history a click would.
 */
export async function batchValidate(
  db: Db,
  evaluationId: string,
  filter: BatchFilter,
  userId: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .select({ grading: gradings })
    .from(gradings)
    .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
    .where(
      and(
        eq(attempts.evaluationId, evaluationId),
        officialAttempt,
        eq(gradings.state, "proposed"),
        filter.itemId ? eq(gradings.itemId, filter.itemId) : undefined,
        filter.source ? eq(gradings.source, filter.source) : undefined,
        filter.confidence ? eq(gradings.confidence, filter.confidence) : undefined,
      ),
    )
    .orderBy(asc(gradings.gradedAt));
  // The placeholders (0 points, no confidence: an essay, a manual circuit,
  // no runner) are left to a person — the same rule the panel counts by, so
  // it is read here in TypeScript rather than restated in SQL.
  const batchable = rows.filter(({ grading }) => isBatchable(grading)).map(({ grading }) => grading);
  const criteria = new Map((await joinedItems(db, evaluationId)).map((i) => [i.item.id, criteriaOf(i)]));
  const written = await writeGradings(
    db,
    batchable.map((grading) => validationOf(grading, {}, criteria.get(grading.itemId) ?? [], userId, now)),
  );
  return written.length;
}

/**
 * Stands down the AUTOMATIC gradings of one attempt (ADR-067): a reopened
 * exercise attempt was graded at its hand-in, and the pass never touches a
 * validated cell, so without this what the student rewrites would keep its
 * first grades. Every standing grading the machine alone wrote (`source`
 * `auto`, the runner's included, no `gradedBy`) is superseded with no
 * successor, the way {@link regradeItem} stands a cell down: the next hand-in
 * grades the cell again, and nothing is deleted (F-GRADE-05). What a teacher
 * settled stays: an override (`manual`), a proposal they validated (it keeps
 * its source but carries their `gradedBy`), and a model's proposal (`llm`,
 * never written while an evaluation runs). So does a CHECKED question's
 * (ADR-124 §3): the reopen does not unlock it, so its answer cannot change,
 * and its grading still describes it.
 *
 * The caller holds the attempt's row lock (`reopenAttempt`): a grading write
 * of the jobs takes the same lock and re-reads the attempt's state under it,
 * so a pass that loaded the attempt finished never lands after this.
 */
export async function standDownAutomaticGradings(db: DbOrTx, attemptId: string): Promise<void> {
  await db
    .update(gradings)
    .set({ state: "superseded" })
    .where(
      and(
        eq(gradings.attemptId, attemptId),
        eq(gradings.source, "auto"),
        isNull(gradings.gradedBy),
        ne(gradings.state, "superseded"),
        notExists(
          db
            .select({ id: answers.id })
            .from(answers)
            .where(
              and(
                eq(answers.attemptId, gradings.attemptId),
                eq(answers.itemId, gradings.itemId),
                isNotNull(answers.checkedAt),
              ),
            ),
        ),
      ),
    );
}
