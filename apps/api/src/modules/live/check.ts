/**
 * The per-question check of an exercise (ADR-124 §3): during an attempt the
 * student checks one question, and reads its verdict, its key and its
 * explanation; the question is then locked for the rest of the attempt.
 * Imported through `./service.ts`.
 */
import type { FastifyInstance } from "fastify";

import { and, eq } from "drizzle-orm";

import type { CheckResponse } from "@quiz/contracts";
import { checkAllowed, checkRefusal } from "@quiz/domain";

import { iso } from "../../clock.js";
import type { JoinedItem } from "../evaluation/service.js";
import { answers, attempts } from "../../db/schema.js";
import { checkGrading, enqueueCheckRun, writeCheckGrading } from "../grading/jobs.js";
import type { GradingRecord } from "../grading/service.js";
import { studentItemCorrection } from "../results/service.js";
import { LiveError, assertWritable, type AnswerRecord, type AttemptRecord } from "./attempt.js";
import { answeredBy, writeAnswer, type AnswerWrite } from "./autosave.js";
import { attemptItemView } from "./itemView.js";

/**
 * `POST /attempts/:id/answers/:itemId/check`:
 *
 *   1. off an exercise, `409 not_checkable` before anything is written;
 *   2. the answer the request carries is written by the autosave's own path
 *      ({@link writeAnswer}: the write gate, the revision guard of ADR-067
 *      §4, the refusal of a question checked already) — a stale revision is
 *      not an error: the check grades what is stored, which the reply hands
 *      back for the client to adopt;
 *   3. the MARK ({@link markChecked}), one transaction under the attempt's
 *      update lock: the gate on the server's clock (`410 attempt_closed`
 *      past the deadline plus the grace, invariant 5), the stored answer
 *      refused by the rule (`409 item_checked`, `422 nothing_to_check`) or
 *      marked checked. From then on the answer is frozen: every write
 *      statement refuses a checked row, an autosave racing the mark
 *      included (it waits on the lock, then finds the row checked);
 *   4. the frozen answer graded (`checkGrading`): an instant verdict written
 *      (`writeCheckGrading`), a runner's job sent (`enqueueCheckRun`).
 *      Should either fail, the check still answers — the key, the verdict
 *      `pending` — and the hand-in's pass grades the cell, which it finds
 *      with no validated grading;
 *   5. the correction, through the one student exit of a key
 *      (`studentItemCorrection`).
 *
 * Not audited, like every write of a student to their own attempt.
 */
export async function checkItem(app: FastifyInstance, input: AnswerWrite): Promise<CheckResponse> {
  const { evaluation, itemId, now } = input;
  if (!checkAllowed(evaluation.mode)) throw new LiveError("not_checkable");
  const { reply, joined: item } = await writeAnswer(app.db, input);
  const { attempt, answer } = await markChecked(app, input, item);
  const grading = await gradeChecked(app, { evaluation, item, attempt, answer });
  const correction = studentItemCorrection({
    evaluation,
    attemptState: attempt.state,
    checked: true,
    item: item.item,
    itemView: attemptItemView(evaluation, item, attempt),
    grading,
  });
  // `itemCorrectionShown` holds for a checked question of an exercise.
  if (correction === null) throw new LiveError("internal_error");
  return { ...reply, correction, serverNow: iso(now) };
}

/**
 * Under the attempt's update lock: the write gate, then the answer as it
 * stands, refused or marked checked. Returns the attempt as locked and the
 * answer, frozen.
 */
async function markChecked(
  app: FastifyInstance,
  input: AnswerWrite,
  item: JoinedItem,
): Promise<{ attempt: AttemptRecord; answer: AnswerRecord }> {
  const answered = answeredBy(item);
  return app.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(attempts).where(eq(attempts.id, input.attempt.id)).for("update");
    if (!locked) throw new LiveError("not_found");
    assertWritable(input.evaluation, locked, input.now);
    const [current] = await tx
      .select()
      .from(answers)
      .where(and(eq(answers.attemptId, locked.id), eq(answers.itemId, input.itemId)))
      .limit(1);
    const refusal = checkRefusal({
      checked: current?.checkedAt != null,
      answered: current !== undefined && answered(current.payload),
    });
    if (refusal !== null) throw new LiveError(refusal);
    const [marked] = await tx
      .update(answers)
      .set({ checkedAt: input.now })
      .where(eq(answers.id, current!.id))
      .returning();
    return { attempt: locked, answer: marked! };
  });
}

/**
 * The grading of a checked, frozen answer: the instant verdict written, or
 * `null` for one to come (a runner's, the hand-in's). A failure after the
 * mark is logged and answered `null`: the question stays checked, and the
 * hand-in's pass grades the cell.
 */
async function gradeChecked(
  app: FastifyInstance,
  cell: Parameters<typeof checkGrading>[1],
): Promise<GradingRecord | null> {
  try {
    const graded = await checkGrading(app, cell);
    if (graded === null) return null;
    if ("write" in graded) return await writeCheckGrading(app, graded.write);
    await enqueueCheckRun(app, graded.runner);
    return null;
  } catch (err) {
    app.log.error({ err, itemId: cell.item.item.id }, "check: not graded after the mark; the hand-in grades the cell");
    return null;
  }
}
