/**
 * `grading_ready` (ADR-030, addendum §c): the automatic grading of an
 * evaluation finished and proposals remain for the staff to validate.
 *
 * "Finished" is the grid being COMPLETE: every (attempt × item) cell holds a
 * standing grading, validated or proposed, so no runner job is still out. A
 * pass that leaves empty cells to the runner says nothing; the runner job
 * that fills the last one does (`jobs.ts`).
 *
 * The guard against duplicates is on the caller: the pass announces only
 * when it filled a cell that had no grading, or when it is the pass of the
 * close (`announce`); a runner job only when its own cell had none. A pass
 * run again with nothing new — the "Run grading" button pressed twice, a
 * restart of the job — fills nothing and tells nobody, and the teacher is
 * told once per grading pass, never once per cell.
 */
import type { FastifyInstance } from "fastify";

import { notifyMany } from "../notifications/service.js";
import { byId, type EvaluationRecord } from "../evaluation/service.js";
import { staffOf } from "./events.js";
import { progressOf } from "./service.js";

/**
 * Tells the course's staff seats (`staffOf`: the rows `staffAccess` reads,
 * no seatless admin) that the grid is complete and how many proposals wait.
 * Nothing while the evaluation still runs — a retake graded alone mid-run
 * (ADR-025) is not the end of anything — and nothing for a poll, which has
 * no key to grade against.
 *
 * Best-effort: a notification that fails is logged and never fails the job,
 * whose grading is already written (a retried pass would redo it all).
 */
export async function announceGradingReady(
  app: FastifyInstance,
  evaluation: EvaluationRecord,
): Promise<void> {
  if (evaluation.mode === "poll") return;
  try {
    // The state NOW, not the row the job loaded when it started: a runner
    // job picked up while the evaluation ran may finish after its close, and
    // it may be the one that completes the grid.
    const current = await byId(app.db, evaluation.id);
    if (!current || current.state === "running" || current.state === "paused") return;
    const progress = await progressOf(app.db, evaluation.id);
    const proposed = progress.pending.runner + progress.pending.llm + progress.failed;
    if (progress.done + proposed < progress.total || proposed === 0) return;
    const staff = await staffOf(app.db, evaluation);
    await notifyMany(
      app.db,
      staff.map((userId) => ({
        userId,
        payload: {
          kind: "grading_ready",
          evaluationId: evaluation.id,
          evaluationTitle: current.title,
          count: proposed,
        },
      })),
    );
  } catch (err) {
    app.log.error({ err, evaluationId: evaluation.id }, "grading: telling the staff failed");
  }
}
