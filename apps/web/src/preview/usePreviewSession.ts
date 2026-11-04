/**
 * The {@link PlayerSession} of the teacher's stateless evaluation preview
 * (issue #75, ADR-018 fourth addendum): the local session
 * (`useLocalPlayerSession`), loaded from the view the server built for the
 * preview's seed, with what the preview adds:
 *
 *   - the clock is the browser's. There is no attempt for the server to own
 *     a deadline on, and nothing is refused at the deadline: reaching zero
 *     simply hands the paper in, the way the ticker would;
 *   - Run and Simulate go to the preview's own routes with the seed, and the
 *     server rebuilds the program from the stored template (invariant 14).
 */
import { useCallback, useEffect, useRef } from "react";

import { PreviewRunBody, PreviewSimulateBody, type EvaluationPreview } from "@quiz/contracts";

import { postRun, postSimulate, runBody } from "../attempt/run";
import { useLocalPlayerSession } from "../attempt/useLocalPlayerSession";
import type { PlayerSession } from "../student/Player";

export function usePreviewSession({
  evaluationId,
  preview,
  startedAt,
  onSubmit,
}: {
  evaluationId: string;
  preview: EvaluationPreview;
  /** Epoch ms, taken by the page when the preview arrived. */
  startedAt: number;
  /** Hands the answers in: the page grades them and shows the correction. */
  onSubmit: (answers: Record<string, unknown>) => Promise<void>;
}): PlayerSession {
  const base = `/app/api/evaluations/${evaluationId}/preview`;
  const seed = preview.seed;
  const deadlineAt = preview.durationS === null ? null : startedAt + preview.durationS * 1000;

  // No runner, or its budget spent: the player says so in one line.
  const run = useCallback<PlayerSession["run"]>(
    (itemId, regions, manual, options) =>
      postRun(`${base}/run`, PreviewRunBody.parse({ seed, ...runBody(itemId, regions, manual, options) })),
    [base, seed],
  );
  const simulate = useCallback<PlayerSession["simulate"]>(
    (itemId, answer) => postSimulate(`${base}/simulate`, PreviewSimulateBody.parse({ seed, itemId, answer })),
    [base, seed],
  );

  const session = useLocalPlayerSession({ view: preview.view, deadlineAt, onSubmit, run, simulate });
  const { submit } = session;

  // Reaching zero hands the paper in, as the ticker does for a student —
  // ONCE, from one timer set for the deadline: nothing here ticks, so the
  // screen does not re-render every second for it. A failed automatic
  // hand-in is not retried (not even when `submit` changes and the timer is
  // set again): the page says the grading failed, and "Hand in" is how the
  // teacher tries again.
  const autoFired = useRef(false);
  useEffect(() => {
    if (deadlineAt === null) return;
    const timer = setTimeout(() => {
      if (autoFired.current) return;
      autoFired.current = true;
      void submit().catch(() => {
        // The page says what went wrong.
      });
    }, Math.max(0, deadlineAt - Date.now()));
    return () => clearTimeout(timer);
  }, [deadlineAt, submit]);

  return session;
}
