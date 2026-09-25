/**
 * The {@link PlayerSession} of the teacher's stateless evaluation preview
 * (issue #75, ADR-018 fourth addendum).
 *
 * It is `useAttempt` with the server taken out of everything but the buttons:
 *   - the state is the SAME reducer (`playerReducer`), loaded from the view
 *     the server built for the preview's seed, so navigation, locks and
 *     milestones behave exactly as in an exam;
 *   - the answers live here and nowhere else — no autosave, no stream, no
 *     journal, no position — and die with the tab;
 *   - the clock is the browser's. There is no attempt for the server to own
 *     a deadline on, and nothing is refused at the deadline: reaching zero
 *     simply hands the paper in, the way the ticker would;
 *   - Run and Simulate go to the preview's own routes with the seed, and the
 *     server rebuilds the program from the stored template (invariant 14).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  PreviewRunBody,
  PreviewSimulateBody,
  type EvaluationPreview,
  type RunAccepted,
  type RunnerResultEvent,
} from "@quiz/contracts";
import type { RunnerOutcome } from "@quiz/core/server";

import { ApiError, api } from "../api";
import { emptyPlayerState, playerReducer } from "../attempt/playerReducer";
import type { PlayerSession } from "../student/Player";

/** The run result of the API, in the shape the player's runner speaks. */
function toOutcome(result: RunnerResultEvent["result"]): RunnerOutcome | "unavailable" {
  if (result.status === "unavailable" || result.status === "busy") return "unavailable";
  if (result.status === "error") throw new Error(result.message);
  return {
    compile: { ok: result.compile.ok, stdout: "", stderr: result.compile.stderr, ms: 0 },
    cases: result.cases.map((c) => ({
      exitCode: c.exitCode,
      stdout: c.stdout,
      stderr: c.stderr,
      ms: c.ms,
      timedOut: c.timedOut,
      oom: c.oom,
      truncated: c.truncated,
    })),
  };
}

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
  const [state, dispatch] = useReducer(playerReducer, emptyPlayerState);
  const [now, setNow] = useState(() => Date.now());
  const base = `/app/api/evaluations/${evaluationId}/preview`;
  const seed = preview.seed;

  useEffect(() => {
    dispatch({ type: "load", view: preview.view });
  }, [preview.view]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const deadlineAt = preview.durationS === null ? null : startedAt + preview.durationS * 1000;

  // The latest answers, for a submit fired by the clock rather than a click.
  const answers = useRef(state.answers);
  answers.current = state.answers;
  const handedIn = useRef(false);
  const submit = useCallback(async () => {
    if (handedIn.current) return;
    handedIn.current = true;
    try {
      await onSubmit(answers.current);
    } catch (error) {
      // A failed grading leaves the preview playable, and "Hand in" works again.
      handedIn.current = false;
      throw error;
    }
  }, [onSubmit]);

  // Reaching zero hands the paper in, as the ticker does for a student —
  // ONCE. A failed automatic hand-in is not retried every second (the clock
  // keeps ticking past zero): the page says the grading failed, and "Hand in"
  // is how the teacher tries again.
  const autoFired = useRef(false);
  useEffect(() => {
    if (deadlineAt === null || now < deadlineAt || autoFired.current) return;
    autoFired.current = true;
    void submit().catch(() => {
      // The page says what went wrong.
    });
  }, [deadlineAt, now, submit]);

  const setAnswer = useCallback((itemId: string, payload: unknown, answered?: boolean) => {
    dispatch({ type: "answer", itemId, payload, ...(answered === undefined ? {} : { answered }) });
  }, []);

  const markDone = useCallback(async (itemId: string, done: boolean) => {
    dispatch({ type: "done", itemId, done });
  }, []);

  // Issue #89: the preview keeps the skip and the flag in the browser, like
  // its answers — the teacher sees the same list states the student will.
  const skip = useCallback(async (itemId: string, skipped: boolean) => {
    dispatch({ type: "skip", itemId, skipped });
  }, []);

  const flag = useCallback(async (itemId: string, flagged: boolean) => {
    dispatch({ type: "flag", itemId, flagged });
  }, []);

  const run = useCallback<PlayerSession["run"]>(
    async (itemId, regions, manual, options) => {
      const body = PreviewRunBody.parse(
        options?.compileOnly === true
          ? { seed, itemId, regions, compileOnly: true }
          : manual === undefined
            ? { seed, itemId, regions }
            : { seed, itemId, regions, stdin: manual.stdin, args: manual.args },
      );
      try {
        const response = await api<RunAccepted>(`${base}/run`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return toOutcome(response.result);
      } catch (error) {
        // No runner, or its budget spent: the player says so in one line.
        if (error instanceof ApiError && error.status === 503) return "unavailable";
        if (error instanceof ApiError && error.status === 429) return "rate_limited";
        throw error;
      }
    },
    [base, seed],
  );

  const simulate = useCallback<PlayerSession["simulate"]>(
    async (itemId, answer) => {
      const body = PreviewSimulateBody.parse({ seed, itemId, answer });
      try {
        return await api<RunnerOutcome>(`${base}/simulate`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 503) return "unavailable";
        if (error instanceof ApiError && error.status === 429) return "rate_limited";
        throw error;
      }
    },
    [base, seed],
  );

  return useMemo(
    () => ({
      state,
      dispatch,
      now,
      deadlineAt,
      closed: null,
      paused: false,
      setAnswer,
      markDone,
      skip,
      flag,
      submit,
      run,
      simulate,
    }),
    [state, now, deadlineAt, setAnswer, markDone, skip, flag, submit, run, simulate],
  );
}
