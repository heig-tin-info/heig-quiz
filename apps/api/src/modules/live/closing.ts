/**
 * The end of one attempt and its way back: the grading at hand-in (ADR-067),
 * submitting (F-LIVE-10), the teacher's close of one attempt (F-LIVE-11) and
 * the reopen, with the rules the live grid reads.
 */
import type { FastifyInstance } from "fastify";

import { eq } from "drizzle-orm";

import type { CourseRole } from "@quiz/contracts";

import { endKioskSessions } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import { attempts } from "../../db/schema.js";
import { retakesEnabled, type EvaluationRecord } from "../evaluation/service.js";
import { enqueueEvaluationGrading } from "../grading/jobs.js";
import { standDownAutomaticGradings } from "../grading/service.js";
import { keyShownTo } from "../results/service.js";
import { attemptById, participantOfAttempt, type AttemptRecord } from "./access.js";
import { deadlineFor } from "./deadline.js";
import { endAttempts, seated } from "./dwell.js";
import * as events from "./events.js";
import { LiveError } from "./failures.js";
import { assertGate } from "./gates.js";

/**
 * Why no finished attempt of this evaluation may be reopened, whatever its
 * state: the rule `reopenAttempt` applies and the live grid reads
 * (`DashboardView.evaluation.reopenable`), so the grid never offers a
 * refused Reopen.
 */
export function reopenRefusal(
  evaluation: EvaluationRecord,
): "retakes_enabled" | "correction_published" | null {
  if (retakesEnabled(evaluation)) return "retakes_enabled";
  if (evaluation.correctionPublishedAt !== null) return "correction_published";
  return null;
}

/**
 * The course role reopening an attempt in `attemptState` takes (ADR-068 §3,
 * audit L9): an owner's once the policy has shown its student the answer
 * key of an evaluation that is graded (`keyShownTo`, the rule of their
 * feedback page), any member's otherwise. An exercise is never graded and
 * shows its key at every hand-in (ADR-124): reopening one stays any
 * member's. The route's loader applies it; the owner's reopening is then a
 * derogation, audited as such.
 */
export function reopenRole(evaluation: EvaluationRecord, attemptState: string): CourseRole {
  if (evaluation.mode === "exercise") return "assistant";
  return keyShownTo(evaluation, attemptState) ? "owner" : "assistant";
}

/**
 * An attempt of an EXERCISE is graded alone as soon as it is finished —
 * handed in, expired, or closed by the teacher — while the exercise runs
 * (ADR-067): whatever its feedback policy, retakes or not, correction
 * published or not, its automatic cells are settled at once, so the student
 * reads points at hand-in rather than a grid of "not graded" for as long as
 * the exercise stays open. What only a person or a model can grade (an
 * essay, a diagram) stays pending until the close: no model is asked while
 * an evaluation runs (F-LLM-03). An exam is graded at its close, as before,
 * and so is everything a poll holds (nothing: a poll has no key).
 *
 * A practice attempt after the due date (ADR-122) is graded at its hand-in
 * whatever the evaluation's state — it is never in a close's pass — and its
 * pass may ask the model, the evaluation being over (`grading/jobs.ts`).
 */
export async function gradeAtHandIn(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
  ended: readonly { id: string; afterDue: boolean }[],
): Promise<void> {
  if (evaluation.mode !== "exercise") return;
  const live = evaluation.state === "running" || evaluation.state === "paused";
  const attemptIds = ended.filter((a) => live || a.afterDue).map((a) => a.id);
  if (attemptIds.length === 0) return;
  await enqueueEvaluationGrading(app, { evaluationId: evaluation.id, attemptIds });
}

/**
 * F-LIVE-10. Terminal and irreversible for the student.
 *
 * With `app`, an exercise grades the attempt now (ADR-067) —
 * only when THIS call is the one that finished it: a repeated or concurrent
 * submit of the same attempt updates nothing and enqueues nothing.
 */
export async function submitAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  app?: FastifyInstance,
): Promise<AttemptRecord> {
  assertGate(evaluation, attempt, now, "submit");
  // The question on screen stops counting where the attempt ends (ADR-039).
  const finished = await endAttempts(
    db,
    eq(attempts.id, attempt.id),
    { state: "submitted", closedBy: "student", submittedAt: now },
    now,
  );
  const row = (await attemptById(db, attempt.id))!;
  events.attemptClosed(evaluation.id, row, "student", now);
  await endKioskSessions(db, evaluation.id, seated(finished));
  if (app && finished.length > 0) await gradeAtHandIn(app, evaluation, [row]);
  return row;
}

/**
 * Closes ONE attempt without closing the evaluation (F-LIVE-11).
 *
 * Allowed whatever the state of the evaluation: an `in_progress` attempt left
 * behind in a finished evaluation (reopened after the close, before #95) must
 * stay closable. A no-op on an attempt that is already finished.
 */
export async function closeAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  app?: FastifyInstance,
): Promise<AttemptRecord> {
  const closed = await endAttempts(
    db,
    eq(attempts.id, attempt.id),
    { state: "expired", closedBy: "teacher" },
    now,
  );
  const row = (await attemptById(db, attempt.id))!;
  events.attemptClosed(evaluation.id, row, "teacher", now);
  await endKioskSessions(db, evaluation.id, seated(closed));
  // The pass of the evaluation's close has already run, and it ran while this
  // attempt was open: grade it now, alone (the pass never touches a cell a
  // teacher validated). Not on a `released` evaluation, whose grades are
  // published: those stay the teacher's to change, from the grading panel.
  if (app && closed.length > 0 && evaluation.state === "closed" && !row.afterDue) {
    await enqueueEvaluationGrading(app, { evaluationId: evaluation.id, attemptIds: [row.id] });
  } else if (app && closed.length > 0) {
    await gradeAtHandIn(app, evaluation, [row]);
  }
  return row;
}

/**
 * Reopens one attempt (a student closed a tab too early, a laptop died). The
 * deadline is recomputed from the ORIGINAL start plus everything already
 * granted, so reopening is not a second full duration. In `deadline` timing a
 * shift common to everybody is in `closes_at` and not in `extraS` (#252), so
 * each is counted once.
 */
export async function reopenAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): Promise<{ row: AttemptRecord; derogation: "key_shown" | null }> {
  if (evaluation.state !== "running" && evaluation.state !== "paused") {
    throw new LiveError("evaluation_not_live");
  }
  if (attempt.state === "in_progress") return { row: attempt, derogation: null };
  if (attempt.origin === "paper" || attempt.supersededBy !== null) throw new LiveError("not_reopenable");
  const refused = reopenRefusal(evaluation);
  if (refused !== null) throw new LiveError(refused);
  // The caller's role was the loader's step (`reopenRole`). The audit records
  // whether the student had read the key (audit L9), an exercise's included.
  const derogation = keyShownTo(evaluation, attempt.state) ? "key_shown" : null;
  const participant = await participantOfAttempt(db, evaluation, attempt);
  const { deadlineAt, bonusS } = deadlineFor(evaluation, participant, attempt.startedAt ?? now, attempt.extraS);
  await db.transaction(async (tx) => {
    // The attempt's row lock, which every grading write of the jobs takes
    // too before re-reading the attempt's state (ADR-067): a pass that
    // loaded this attempt finished either commits before the stand-down
    // below (which then supersedes what it wrote) or sees it reopened.
    await tx.select({ id: attempts.id }).from(attempts).where(eq(attempts.id, attempt.id)).for("update");
    await tx
      .update(attempts)
      .set({
        state: "in_progress",
        startedAt: attempt.startedAt ?? now,
        deadlineAt,
        bonusS,
        closedAt: null,
        closedBy: null,
        submittedAt: null,
        updatedAt: now,
      })
      .where(eq(attempts.id, attempt.id));
    // An exercise graded this attempt at its hand-in (ADR-067): those grades
    // no longer describe what the student will hand in next, and the next
    // hand-in grades it again. What a teacher settled by hand stays.
    await standDownAutomaticGradings(tx, attempt.id);
  });
  const row = (await attemptById(db, attempt.id))!;
  events.deadlineChanged(evaluation, row, "reopen", now);
  return { row, derogation };
}
