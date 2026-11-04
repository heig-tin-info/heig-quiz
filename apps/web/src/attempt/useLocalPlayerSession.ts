/**
 * A {@link PlayerSession} whose answers live in the browser: `useAttempt`
 * with the server taken out of everything but the hand-in and the buttons
 * the caller wires. Two screens drive the student player with one — the
 * teacher's stateless preview (issue #75, `preview/usePreviewSession.ts`)
 * and the paper copy a staff member types in (ADR-125, `paper/usePaperSession.ts`)
 * — so neither can look different from the exam:
 *
 *   - the state is the SAME reducer (`playerReducer`), loaded from `view`
 *     each time the caller hands a new one, so navigation, locks and
 *     milestones behave exactly as in an exam;
 *   - the answers, the skip and the flag are dispatched and nothing else: no
 *     autosave, no stream, no journal, no position;
 *   - the clock is the browser's; `deadlineAt` is only shown — a caller that
 *     ends at it sets its own timer;
 *   - `submit` hands the answers to `onSubmit` once at a time; a failure
 *     leaves the session playable, and Hand in works again.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { AttemptView } from "@quiz/contracts";

import type { PlayerSession } from "../student/Player";
import { emptyPlayerState, playerReducer } from "./playerReducer";

export function useLocalPlayerSession({
  view,
  deadlineAt,
  onSubmit,
  run,
  simulate,
}: {
  view: AttemptView;
  /** Epoch ms, or null: no clock. */
  deadlineAt: number | null;
  onSubmit: (answers: Record<string, unknown>) => Promise<void>;
  run: PlayerSession["run"];
  simulate: PlayerSession["simulate"];
}): PlayerSession {
  const [state, dispatch] = useReducer(playerReducer, emptyPlayerState);

  useEffect(() => {
    dispatch({ type: "load", view });
  }, [view]);

  // The latest answers, for a submit fired by a clock rather than a click.
  const answers = useRef(state.answers);
  answers.current = state.answers;
  const handedIn = useRef(false);
  const submit = useCallback(async () => {
    if (handedIn.current) return;
    handedIn.current = true;
    try {
      await onSubmit(answers.current);
    } catch (error) {
      handedIn.current = false;
      throw error;
    }
  }, [onSubmit]);

  const setAnswer = useCallback((itemId: string, payload: unknown, answered?: boolean) => {
    dispatch({ type: "answer", itemId, payload, ...(answered === undefined ? {} : { answered }) });
  }, []);
  const markDone = useCallback(async (itemId: string, done: boolean) => {
    dispatch({ type: "done", itemId, done });
  }, []);
  // Issue #89: the skip and the flag stay in the browser, like the answers.
  const skip = useCallback(async (itemId: string, skipped: boolean) => {
    dispatch({ type: "skip", itemId, skipped });
  }, []);
  const flag = useCallback(async (itemId: string, flagged: boolean) => {
    dispatch({ type: "flag", itemId, flagged });
  }, []);

  return useMemo(
    () => ({
      state,
      dispatch,
      clock: Date.now,
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
    [state, deadlineAt, setAnswer, markDone, skip, flag, submit, run, simulate],
  );
}
