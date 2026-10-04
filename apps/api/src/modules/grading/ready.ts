/**
 * `grading_ready` (ADR-030, addendum §c): the automatic grading of an
 * evaluation finished and proposals remain for the staff to validate.
 *
 * "Finished" is the grid being COMPLETE: every (attempt × item) cell holds a
 * standing grading, validated or proposed, so no runner job is still out.
 *
 * Told ONCE per completed grid (#286), whoever completes it. Every grading
 * path that may complete the grid — the end of a pass, the end of a runner
 * job — calls {@link announceGradingReady} after its own write has
 * committed; it reads the grid as it stands then, and only if it is complete
 * does it claim `evaluations.grading_ready_at` with one conditional UPDATE.
 * Of two writers racing on the last cells, the one that commits last sees
 * both writes; either may claim, and exactly one wins. No flag on a job says
 * "maybe you are the last": a runner job landing between a pass's read and
 * its write can neither make the staff hear twice nor keep them from
 * hearing.
 *
 * The claim is given back by a re-grade (`regradeItem`), which empties the
 * item's cells: the pass that refills them completes a new grid and tells
 * again. A pass run again with nothing new — the "Run grading" button
 * pressed twice, a restart of the job — finds the claim taken and tells
 * nobody.
 */
import type { FastifyInstance } from "fastify";

import { notifyMany } from "../notifications/service.js";
import { byId, claimGradingReady, type EvaluationRecord } from "../evaluation/service.js";
import { staffOf } from "./events.js";
import { progressOf } from "./service.js";

/**
 * Tells the course's staff seats (`staffOf`: the rows `staffAccess` reads,
 * no seatless admin) that the grid is complete and how many proposals wait,
 * if it is and nobody has told them yet. Nothing while the evaluation still
 * runs — an exercise attempt graded alone mid-run (ADR-067) is not the end
 * of anything (`claimGradingReady` refuses it) — nothing for a grid with no
 * proposal,
 * and nothing for a poll, which has no key to grade against.
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
    // The row NOW, not the one the job loaded when it started. Told already,
    // or not closed yet: nothing to read, and the grid scan below — one per
    // runner job — is skipped.
    const current = await byId(app.db, evaluation.id);
    if (!current || current.gradingReadyAt !== null) return;
    if (current.state === "running" || current.state === "paused") return;
    const progress = await progressOf(app.db, current.id);
    const proposed = progress.pending.runner + progress.pending.llm + progress.failed;
    if (progress.done + proposed < progress.total || proposed === 0) return;
    // At most once: claimed BEFORE the send, so a crash between the two
    // drops the notice rather than doubling it (best-effort, ADR-030).
    if (!(await claimGradingReady(app.db, current.id, app.clock.now()))) return;
    const staff = await staffOf(app.db, current);
    await notifyMany(
      app.db,
      staff.map((userId) => ({
        userId,
        payload: {
          kind: "grading_ready",
          evaluationId: current.id,
          evaluationTitle: current.title,
          count: proposed,
        },
      })),
    );
  } catch (err) {
    app.log.error({ err, evaluationId: evaluation.id }, "grading: telling the staff failed");
  }
}
