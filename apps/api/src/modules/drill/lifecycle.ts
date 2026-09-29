/**
 * The life of a drill card (ADR-041 §1–3, §7, §10): created at the release
 * of an exam and at the hand-in of an exercise, removed by the teacher's
 * explicit action, purged after five years. Deleting a classroom, an
 * evaluation or a question takes its cards by the foreign keys of
 * `db/drill.ts` (06, question 28 (a)).
 *
 * The other modules call in through `./service.ts` from their own services
 * (the results' release, the live module's end of an attempt), never from
 * their routes.
 */
import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { GradeContext } from "@quiz/core/server";
import { DRILL_TYPES, isDrillEligible } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import {
  answers,
  attempts,
  classrooms,
  drillCards,
  drillReviews,
  enrollments,
  questionVersions,
} from "../../db/schema.js";
import {
  byId,
  drillAllowed,
  gradeDefaults,
  joinedItems,
  type EvaluationRecord,
} from "../evaluation/service.js";
import { solutionView } from "../live/studentView.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { UnavailableRunner } from "../runner/unavailable.js";

/** A student's drill data is kept five years (N-DATA-03, ADR-041 §8). */
export const DRILL_RETENTION = "5 years";

/**
 * The drill never waits for a runner (ADR-041 §3): a v1 type grades without
 * one, and a type that asked for it would not be eligible anyway.
 */
export const NO_RUNNER = new UnavailableRunner("drill");

/** The item id of the fixed view the key is hashed under: no attempt, no item, no shuffle. */
const KEY_VIEW_ITEM = "drill-key";

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
 */
export function keyHashOf(type: string, version: { config: unknown; configVersion: number }): string {
  const solution = solutionView({ type, version, seed: 0, itemId: KEY_VIEW_ITEM });
  return createHash("sha256").update(canonical(solution)).digest("hex");
}

/** The latest PUBLISHED version of each question: what a drill review serves. */
export async function currentVersions(
  db: Db,
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

interface EndedAttempt {
  id: string;
  userId: string | null;
  seed: number;
}

/**
 * The cards of `ended` attempts of `evaluation`: one per (student, question)
 * of an eligible item, a new card due at once, attached to this classroom
 * and evaluation unless the student already has one (ON CONFLICT: the first
 * meeting wins, 06, question 28 (j)). Nothing when the evaluation does not
 * allow drill, when its classroom has the drill off or is archived, and
 * nothing for a student who opted out, a staff seat or a guest.
 *
 * Eligibility (ADR-041 §3) is the type's own grading of the answer the
 * student gave: graded at once and not a proposal. The grading pass of the
 * evaluation may not have run yet at a hand-in, so the answer is graded
 * here again — the v1 types are pure and fast.
 */
async function createCards(
  db: Db,
  evaluation: EvaluationRecord,
  ended: readonly EndedAttempt[],
  now: Date,
): Promise<number> {
  if (evaluation.classroomId === null || !drillAllowed(evaluation) || ended.length === 0) return 0;
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

  const userIds = [...new Set(ended.flatMap((a) => (a.userId === null ? [] : [a.userId])))];
  if (userIds.length === 0) return 0;
  const seats = await db
    .select({ userId: enrollments.userId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.classroomId, room.id),
        inArray(enrollments.userId, userIds),
        eq(enrollments.staff, false),
        isNull(enrollments.drillOptedOutAt),
      ),
    );
  const drilling = new Set(seats.map((s) => s.userId));
  const takers = ended.filter((a) => a.userId !== null && drilling.has(a.userId));
  if (takers.length === 0) return 0;

  const items = (await joinedItems(db, evaluation.id)).filter((j) =>
    (DRILL_TYPES as readonly string[]).includes(j.question.type),
  );
  if (items.length === 0) return 0;
  const current = await currentVersions(
    db,
    items.map((j) => j.question.id),
  );
  const payloads = new Map(
    (
      await db
        .select({ attemptId: answers.attemptId, itemId: answers.itemId, payload: answers.payload })
        .from(answers)
        .where(inArray(answers.attemptId, takers.map((a) => a.id)))
    ).map((row) => [`${row.attemptId}:${row.itemId}`, row.payload]),
  );
  const defaults = gradeDefaults(evaluation);

  const rows: (typeof drillCards.$inferInsert)[] = [];
  for (const j of items) {
    const type = typeOf(j.question.type);
    const config = loadConfig(j.question.type, j.version);
    const latest = current.get(j.question.id) ?? j.version;
    const keyHash = keyHashOf(j.question.type, latest);
    for (const attempt of takers) {
      const raw = payloads.get(`${attempt.id}:${j.item.id}`) ?? null;
      const parsed = raw === null ? null : type.answerSchema.safeParse(raw);
      const ctx: GradeContext = {
        seed: attempt.seed,
        itemId: j.item.id,
        attemptId: attempt.id,
        itemPoints: j.item.points,
        now,
        runner: NO_RUNNER,
        defaults,
      };
      let eligible: boolean;
      try {
        eligible = isDrillEligible(j.question.type, await type.grade(config, parsed?.success ? parsed.data : null, ctx));
      } catch {
        eligible = false;
      }
      if (!eligible) continue;
      rows.push({
        id: randomUUID(),
        userId: attempt.userId!,
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
 * (ADR-041 §1): every finished attempt of the class. Called by
 * `results.releaseResults`; a re-release creates only what is missing.
 */
export async function cardsAtRelease(db: Db, evaluation: EvaluationRecord, now: Date): Promise<number> {
  if (evaluation.mode !== "exam") return 0;
  const ended = await db
    .select({ id: attempts.id, userId: attempts.userId, seed: attempts.seed })
    .from(attempts)
    .where(
      and(eq(attempts.evaluationId, evaluation.id), inArray(attempts.state, ["submitted", "expired"])),
    );
  return createCards(db, evaluation, ended, now);
}

/**
 * An exercise enters the drill at the hand-in (ADR-041 §1): every end of an
 * attempt — the student's submission, the teacher's close, the expiry, the
 * close of the evaluation — goes through `live`'s `endAttempts`, which calls
 * this with what it ended. An exam's attempt ends here too and creates
 * nothing: its cards wait for the release.
 */
export async function cardsAtHandIn(
  db: Db,
  ended: readonly { id: string; evaluationId: string }[],
  now: Date,
): Promise<number> {
  let created = 0;
  for (const evaluationId of new Set(ended.map((a) => a.evaluationId))) {
    const evaluation = await byId(db, evaluationId);
    if (!evaluation || evaluation.mode !== "exercise") continue;
    const rows = await db
      .select({ id: attempts.id, userId: attempts.userId, seed: attempts.seed })
      .from(attempts)
      .where(
        inArray(
          attempts.id,
          ended.filter((a) => a.evaluationId === evaluationId).map((a) => a.id),
        ),
      );
    created += await createCards(db, evaluation, rows, now);
  }
  return created;
}

/**
 * The hooks of the other modules are best-effort: the release or the
 * hand-in has committed, and a card that failed to be created must not turn
 * it into an error for the teacher or the student. The service layer has no
 * logger (as `results/service.ts`): stderr.
 */
export async function bestEffort(what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`drill: ${what} failed`, err);
  }
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
