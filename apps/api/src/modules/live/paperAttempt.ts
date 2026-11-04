/**
 * The paper attempt's half in the `live` module (ADR-125 §9, §10, §12): the
 * module that owns `attempts` and `answers` writes them, inside the `paper`
 * module's transaction, and nothing else.
 *
 *   - {@link paperKey}: the whole key of each item in the paper's view, for
 *     the staff member typing the copy in;
 *   - {@link paperAnswers} reads every answer of the copy exactly as a
 *     student's save reads one (`canonicalAnswer`: the view of the paper
 *     seed, the type's `answerSchema`, `fromStudentAnswer`), and refuses the
 *     whole copy on the first answer refused (`422 answer_invalid`);
 *   - {@link insertPaperAttempt} ends the student's unfinished attempt, inserts
 *     the paper attempt handed in, stores its answers and marks every attempt
 *     it replaces, in the caller's transaction;
 *   - {@link announcePaperAttempt}, after the commit, tells the listeners of
 *     ended attempts, the dashboard and the player of a replaced attempt.
 *
 * A paper attempt goes through the ordinary ADR-097 path everywhere else: its
 * seed is the evaluation's paper seed, so its views are the hand-out's, with
 * no `origin` case anywhere in the item view.
 */
import { randomUUID } from "node:crypto";

import { and, eq, max, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { AnswerCoordinates } from "@quiz/contracts";

import { endKioskSessions } from "../../auth/session.js";
import type { Tx } from "../../db/client.js";
import { answers, attempts, officialAttempt } from "../../db/schema.js";
import type { EvaluationRecord, JoinedItem } from "../evaluation/service.js";
import { enqueueEvaluationGrading } from "../grading/jobs.js";
import { AnswerInvalid, type AttemptRecord } from "./attempt.js";
import { canonicalAnswer } from "./autosave.js";
import { endAttemptsIn, notifyEnded, seated, type EndedAttempt } from "./dwell.js";
import * as events from "./events.js";
import { attemptItemView } from "./itemView.js";
import { solutionViewOf } from "./studentView.js";

/** A paper attempt draws no values: a parameterized evaluation does not print (ADR-125 §5). */
const onPaper = (seed: number) => ({ seed, instances: {} });

/** Item id → the whole key, in the coordinates of the paper's view. Staff-only. */
export function paperKey(
  evaluation: EvaluationRecord,
  items: readonly JoinedItem[],
  seed: number,
): Record<string, unknown> {
  return Object.fromEntries(
    items.map((entry) => {
      const { type, config, view } = attemptItemView(evaluation, entry, onPaper(seed));
      return [entry.item.id, solutionViewOf(type, config, view)];
    }),
  );
}

/**
 * The answers of a paper copy, canonical, by item: each one read through the
 * student save's path on the view of `seed`. An item left out, or given
 * `null`, was left blank, and so is an answer that holds nothing (the type's
 * `isAnswered`): no answer row, worth zero like an absent answer (F-GRADE-01)
 * — or, for an untranscribed free zone, a proposal (ADR-125 §14). An item id
 * the evaluation does not hold refuses the copy.
 */
export function paperAnswers(
  evaluation: EvaluationRecord,
  items: readonly JoinedItem[],
  seed: number,
  raw: Readonly<Record<string, unknown>>,
  coordinates: AnswerCoordinates | undefined,
): Map<string, unknown> {
  const byId = new Map(items.map((entry) => [entry.item.id, entry]));
  const out = new Map<string, unknown>();
  for (const [itemId, value] of Object.entries(raw)) {
    const joined = byId.get(itemId);
    if (!joined) throw new AnswerInvalid([{ path: [itemId], message: "answer.item_unknown" }]);
    if (value === null || value === undefined) continue;
    try {
      const { payload, answered } = canonicalAnswer(evaluation, joined, onPaper(seed), value, coordinates);
      if (answered) out.set(itemId, payload);
    } catch (error) {
      // Which item was refused, for the entry page to say so.
      if (error instanceof AnswerInvalid) throw new AnswerInvalid({ itemId, issues: error.issues });
      throw error;
    }
  }
  return out;
}

/** What {@link insertPaperAttempt} wrote. */
export interface InsertedPaperAttempt {
  attempt: AttemptRecord;
  /** The attempts it ended (`not_started`, `in_progress` → `expired` by `teacher`). */
  ended: EndedAttempt[];
  /** The attempts it replaced — every official attempt of the student before it — the latest first. */
  superseded: string[];
}

/**
 * The paper attempt of `userId`, handed in (ADR-125 §9, §12), inside the
 * caller's transaction `tx` (which holds the student's seat locked):
 *
 *   1. an unfinished attempt is ended, `expired` by `teacher`, its open
 *      interval on screen credited (ADR-039) — the one way attempts end
 *      (`endAttemptsIn`), which frees the one open attempt the partial index
 *      allows;
 *   2. the paper attempt is inserted, `submitted` by `teacher` now, with no
 *      start and no deadline, on the paper seed, numbered after the highest;
 *   3. its answers are stored, revision 1, never shown on a screen;
 *   4. every official attempt before it is marked replaced by it.
 */
export async function insertPaperAttempt(
  tx: Tx,
  input: {
    evaluation: EvaluationRecord;
    userId: string;
    seed: number;
    answers: ReadonlyMap<string, unknown>;
    now: Date;
  },
): Promise<InsertedPaperAttempt> {
  const { evaluation, userId, now } = input;
  const own = and(eq(attempts.evaluationId, evaluation.id), eq(attempts.userId, userId))!;
  const ended = await endAttemptsIn(
    tx,
    own,
    ["not_started", "in_progress"],
    { state: "expired", closedBy: "teacher" },
    now,
  );

  const [top] = await tx.select({ n: max(attempts.attemptNumber) }).from(attempts).where(own);
  const id = randomUUID();
  const [attempt] = await tx
    .insert(attempts)
    .values({
      id,
      evaluationId: evaluation.id,
      userId,
      guestId: null,
      attemptNumber: (top?.n ?? 0) + 1,
      state: "submitted",
      closedBy: "teacher",
      origin: "paper",
      seed: input.seed,
      instances: {},
      startedAt: null,
      deadlineAt: null,
      submittedAt: now,
      closedAt: now,
      afterDue: false,
      displayTracked: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (input.answers.size > 0) {
    await tx.insert(answers).values(
      [...input.answers].map(([itemId, payload]) => ({
        id: randomUUID(),
        attemptId: id,
        itemId,
        payload,
        revision: 1,
        firstSeenAt: now,
        updatedAt: now,
      })),
    );
  }

  // Every official attempt before it: the paper attempt alone counts now.
  const superseded = await tx
    .update(attempts)
    .set({ supersededBy: id, updatedAt: now })
    .where(and(own, ne(attempts.id, id), officialAttempt))
    .returning({ id: attempts.id, number: attempts.attemptNumber });
  superseded.sort((a, b) => b.number - a.number);

  return { attempt: attempt!, ended, superseded: superseded.map((row) => row.id) };
}

/**
 * After the commit of {@link insertPaperAttempt}: the listeners of ended
 * attempts run, the player of an attempt it ended learns it was closed by a
 * teacher, the station that sat it is let go, and the dashboards re-read the
 * student's row — the attempt it shows changed — then a closed evaluation
 * grades the paper attempt now; a running or paused one grades it at its
 * close, like any hand-in (ADR-125 §9).
 */
export async function announcePaperAttempt(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
  inserted: InsertedPaperAttempt,
  now: Date,
): Promise<void> {
  await notifyEnded(app.db, inserted.ended, now);
  for (const ended of inserted.ended) events.attemptClosed(evaluation.id, ended, "teacher", now);
  if (inserted.ended.length > 0) await endKioskSessions(app.db, evaluation.id, seated(inserted.ended));
  events.attemptRowChanged(evaluation.id, inserted.attempt);
  // The row's origin, attempt count and cells changed with it: a re-read.
  events.rosterChanged(evaluation.id);
  if (evaluation.state === "closed" || evaluation.state === "grading") {
    await enqueueEvaluationGrading(app, { evaluationId: evaluation.id, attemptIds: [inserted.attempt.id] });
  }
}
