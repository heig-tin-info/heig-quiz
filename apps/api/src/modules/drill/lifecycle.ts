/**
 * The life of a drill card (ADR-041 §1–3, §7, §10): created at the release
 * of an exam and at the hand-in of an exercise, removed by the teacher's
 * explicit action, purged after five years. Deleting a classroom, an
 * evaluation or a question takes its cards by the foreign keys of
 * `db/drill.ts` (06, question 28 (a)).
 *
 * The release arrives through `results`' `onResultsReleased` hook, the
 * hand-in through `live`'s `onAttemptsEnded`; `./service.ts` registers both,
 * and neither module imports this one.
 */
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { GradeContext } from "@quiz/core/server";
import { DRILL_TYPES, isDrillEligible } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import {
  attempts,
  classrooms,
  drillCards,
  drillReviews,
  enrollments,
  evaluations,
  questionVersions,
} from "../../db/schema.js";
import {
  byId,
  drillAllowed,
  gradeDefaults,
  joinedItems,
  type DbOrTx,
  type EvaluationRecord,
} from "../evaluation/service.js";
import { solutionView, type EndedAttempt } from "../live/service.js";
import {
  exampleConfig,
  isParameterized,
  loadConfig,
  templateHash,
  typeOf,
  type VersionContent,
} from "../pool/service.js";
import { UnavailableRunner } from "../runner/index.js";

/** A student's drill data is kept five years (N-DATA-03, ADR-041 §8). */
export const DRILL_RETENTION = "5 years";

/** The item id of the fixed view the key is hashed under: no attempt, no item, no shuffle. */
const KEY_VIEW_ITEM = "drill-key";

/**
 * THE grading context of the drill. The drill never waits for a runner
 * (ADR-041 §3): a v1 type grades without one. `key` stands for the item and
 * the attempt, which a review has neither of: the card id, or a fixed name
 * for the eligibility probe.
 */
export function drillGradeContext(input: {
  seed: number;
  key: string;
  itemPoints: number;
  now: Date;
  defaults: Readonly<Record<string, unknown>>;
}): GradeContext {
  return {
    seed: input.seed,
    itemId: input.key,
    attemptId: input.key,
    itemPoints: input.itemPoints,
    now: input.now,
    runner: new UnavailableRunner("drill"),
    defaults: input.defaults,
  };
}

/**
 * Whether a QUESTION can be drilled (ADR-041 §3): its type is in the v1
 * scope and grades an answer automatically and finally. A property of the
 * question, not of one answer: it is decided once, from the type's grading
 * of an empty answer under the evaluation's settings — the four v1 types
 * settle it at once, validated, whatever they are configured with. A type
 * that would hand an answer to a runner, an LLM or the teacher says so
 * there too.
 */
export async function isDrillableQuestion(
  type: string,
  config: unknown,
  defaults: Readonly<Record<string, unknown>>,
  now: Date,
): Promise<boolean> {
  if (!(DRILL_TYPES as readonly string[]).includes(type)) return false;
  const t = typeOf(type);
  try {
    const probe = drillGradeContext({ seed: 0, key: KEY_VIEW_ITEM, itemPoints: t.defaultPoints(config), now, defaults });
    return isDrillEligible(type, await t.grade(config, null, probe));
  } catch {
    return false;
  }
}

/** JSON with its object keys sorted, so that equal keys hash equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The fingerprint of a question's answer key (ADR-041 §10): sha256 of its
 * `toSolution` under a fixed view. A card whose stored hash differs is
 * reset at its next review (§7); a rewording that leaves the key alone keeps
 * the card's FSRS state.
 *
 * A parameterized question's key is its TEMPLATE (ADR-056 §5), never one
 * instance: each review draws new values, and a new draw must not reset the
 * card. An edit of a formula does.
 */
export function keyHashOf(type: string, version: VersionContent): string {
  if (isParameterized(version)) return templateHash(type, version);
  const solution = solutionView({ type, version, seed: 0, itemId: KEY_VIEW_ITEM });
  return createHash("sha256").update(canonical(solution)).digest("hex");
}

/** The latest PUBLISHED version of each question: what a drill review serves. */
export async function currentVersions(
  db: DbOrTx,
  questionIds: readonly string[],
): Promise<Map<string, typeof questionVersions.$inferSelect>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([questionVersions.questionId])
    .from(questionVersions)
    .where(and(inArray(questionVersions.questionId, [...questionIds]), isNotNull(questionVersions.number)))
    .orderBy(questionVersions.questionId, sql`${questionVersions.number} desc`);
  return new Map(rows.map((row) => [row.questionId, row]));
}

/**
 * The cards of the students `userIds` who took `evaluation`: one per
 * (student, drillable question), a new card due at once, attached to this
 * classroom and evaluation unless the student already has one (ON CONFLICT:
 * the first meeting wins, 06, question 28 (j)). Nothing when the evaluation
 * does not allow drill, when its classroom has the drill off or is archived,
 * and nothing for a student who opted out, a staff seat or a guest.
 */
async function createCards(
  db: Db,
  evaluation: EvaluationRecord,
  userIds: readonly string[],
  now: Date,
): Promise<number> {
  if (evaluation.classroomId === null || !drillAllowed(evaluation) || userIds.length === 0) return 0;
  const [room] = await db
    .select({ id: classrooms.id })
    .from(classrooms)
    .where(
      and(
        eq(classrooms.id, evaluation.classroomId),
        isNotNull(classrooms.drillEnabledAt),
        isNull(classrooms.archivedAt),
      ),
    );
  if (!room) return 0;
  const seats = await db
    .select({ userId: enrollments.userId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.classroomId, room.id),
        inArray(enrollments.userId, [...userIds]),
        eq(enrollments.staff, false),
        isNull(enrollments.drillOptedOutAt),
      ),
    );
  const takers = seats.flatMap((s) => (s.userId === null ? [] : [s.userId]));
  if (takers.length === 0) return 0;

  const items = await joinedItems(db, evaluation.id);
  const current = await currentVersions(
    db,
    items.map((j) => j.question.id),
  );
  const defaults = gradeDefaults(evaluation);
  const rows: (typeof drillCards.$inferInsert)[] = [];
  for (const j of items) {
    // The card serves the question as it stands now (ADR-041 §7).
    const version = current.get(j.question.id) ?? j.version;
    // Whether it can be drilled is a matter of structure: a parameterized
    // question answers it on its example instance (ADR-056).
    if (!(await isDrillableQuestion(j.question.type, exampleConfig(j.question.type, version), defaults, now))) continue;
    const keyHash = keyHashOf(j.question.type, version);
    for (const userId of takers) {
      rows.push({
        id: randomUUID(),
        userId,
        questionId: j.question.id,
        classroomId: room.id,
        evaluationId: evaluation.id,
        dueAt: now,
        keyHash,
        createdAt: now,
      });
    }
  }
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(drillCards)
    .values(rows)
    .onConflictDoNothing({ target: [drillCards.userId, drillCards.questionId] })
    .returning({ id: drillCards.id });
  return inserted.length;
}

/**
 * An exam enters the drill at the release of its results, never before
 * (ADR-041 §1): every student with a finished attempt. Called after
 * `results.releaseResults`; a re-release creates only what is missing.
 */
export async function cardsAtRelease(db: Db, evaluation: EvaluationRecord, now: Date): Promise<number> {
  if (evaluation.mode !== "exam") return 0;
  return createCards(db, evaluation, await finishedTakers(db, evaluation.id), now);
}

/** The students with a finished attempt of an evaluation: who handed it in. */
async function finishedTakers(db: Db, evaluationId: string): Promise<string[]> {
  const ended = await db
    .selectDistinct({ userId: attempts.userId })
    .from(attempts)
    .where(and(eq(attempts.evaluationId, evaluationId), inArray(attempts.state, ["submitted", "expired"])));
  return ended.flatMap((a) => (a.userId === null ? [] : [a.userId]));
}

/**
 * The drill enabled for a classroom — the first time or again (ADR-041
 * §13): the cards its past evaluations would have created, by the same path —
 * the exams whose results are released, the exercises for every student who
 * handed one in. Idempotent: a card that exists is kept, the first meeting
 * wins, and an evaluation that does not allow drill creates nothing.
 */
export async function backfillClassroom(db: Db, classroomId: string, now: Date): Promise<number> {
  const rows = await db
    .select()
    .from(evaluations)
    .where(and(eq(evaluations.classroomId, classroomId), inArray(evaluations.mode, ["exam", "exercise"])))
    .orderBy(evaluations.createdAt, evaluations.id);
  let created = 0;
  for (const evaluation of rows) {
    if (evaluation.mode === "exam" && evaluation.releasedAt === null) continue;
    created += await createCards(db, evaluation, await finishedTakers(db, evaluation.id), now);
  }
  return created;
}

/**
 * An exercise enters the drill at the hand-in (ADR-041 §1): every end of an
 * attempt — the student's submission, the teacher's close, the expiry, the
 * close of the evaluation — goes through `live`'s `endAttempts`, whose hook
 * hands over what it ended. An exam's attempt ends there too and creates
 * nothing: its cards wait for the release.
 */
export async function cardsAtHandIn(db: Db, ended: readonly EndedAttempt[], now: Date): Promise<number> {
  let created = 0;
  for (const evaluationId of new Set(ended.map((a) => a.evaluationId))) {
    const evaluation = await byId(db, evaluationId);
    if (!evaluation || evaluation.mode !== "exercise") continue;
    const userIds = ended.flatMap((a) => (a.evaluationId === evaluationId && a.userId !== null ? [a.userId] : []));
    created += await createCards(db, evaluation, [...new Set(userIds)], now);
  }
  return created;
}

/** How many cards an evaluation gave rise to. */
export async function evaluationCardCount(db: Db, evaluationId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(drillCards)
    .where(eq(drillCards.evaluationId, evaluationId));
  return row?.n ?? 0;
}

/**
 * "Remove these questions from the drill" (ADR-041 §10, item 3): every card
 * the evaluation gave rise to, and their reviews with them. A card another
 * evaluation gave rise to first is not this one's to remove.
 */
export async function removeEvaluationCards(db: Db, evaluationId: string): Promise<number> {
  const removed = await db
    .delete(drillCards)
    .where(eq(drillCards.evaluationId, evaluationId))
    .returning({ id: drillCards.id });
  return removed.length;
}

/**
 * The retention of N-DATA-03 (ADR-041 §10): a review goes five years after
 * it was made, a card five years after its last review, or its creation if
 * it was never reviewed. The `drill.purge` ticker task.
 */
export async function purgeExpiredDrill(db: Db, now: Date): Promise<{ reviews: number; cards: number }> {
  const cutoff = sql`${now.toISOString()}::timestamptz - interval '${sql.raw(DRILL_RETENTION)}'`;
  const reviews = await db
    .delete(drillReviews)
    .where(sql`${drillReviews.reviewedAt} < ${cutoff}`)
    .returning({ id: drillReviews.id });
  const cards = await db
    .delete(drillCards)
    .where(sql`coalesce(${drillCards.lastReviewAt}, ${drillCards.createdAt}) < ${cutoff}`)
    .returning({ id: drillCards.id });
  return { reviews: reviews.length, cards: cards.length };
}
