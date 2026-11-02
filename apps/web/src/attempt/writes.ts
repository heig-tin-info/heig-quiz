/**
 * The attempt's state writes beside the answers: validate, skip, flag, check
 * (ADR-124 §3), hand in. Each one is a single POST whose answer carries `serverNow` (fed to the
 * server clock), and none of them decides anything the server has not — a
 * `410` is how the client learns that the attempt is over or paused.
 */
import { useCallback } from "react";

import {
  ANSWER_COORDINATES,
  CheckRequest,
  CheckResponse,
  FlagBody,
  FlagResponse,
  MarkDoneBody,
  MarkDoneResponse,
  SkipBody,
  SkipResponse,
  type AttemptClosed,
  type SubmitResponse,
} from "@quiz/contracts";

import { ApiError, api, refusedWith } from "../api";
import type { Autosave } from "./autosave";
import type { PlayerAction } from "./playerReducer";

/**
 * A write that depends on the answer (a validation, a skip) was not sent:
 * the latest answer is not on the server yet. The player says so and keeps
 * the question open (issue #89).
 */
export class UnsavedAnswer extends Error {
  constructor() {
    super("the latest answer is not saved yet");
  }
}

export interface StateWrites {
  /** F-LIVE-08: validate — "Validate and continue", crossing a checkpoint. */
  markDone: (itemId: string, done: boolean) => Promise<void>;
  /** Issue #89: "I won't answer this question", or taking it back. */
  skip: (itemId: string, skipped: boolean) => Promise<void>;
  /** Issue #89: the review flag. */
  flag: (itemId: string, flagged: boolean) => Promise<void>;
  /**
   * ADR-124 §3: check a question of an exercise — its correction, and the
   * question locked for the rest of the attempt. `answer` is the one on
   * screen, which the check writes first.
   */
  check: (itemId: string, answer: unknown) => Promise<void>;
  submit: () => Promise<void>;
}

export function useStateWrites({
  attemptId,
  preview,
  closed,
  saver,
  sample,
  dispatch,
  end,
  pause,
  refresh,
}: {
  attemptId: string;
  /** The teacher's walk of their own quiz: nothing is written. */
  preview: boolean;
  /** The attempt stopped accepting writes. */
  closed: boolean;
  saver: Autosave;
  sample: (serverNow: string) => void;
  dispatch: (action: PlayerAction) => void;
  /** The attempt is over, for `reason`: read-only from now on. */
  end: (reason: AttemptClosed["reason"]) => void;
  /** The teacher paused (D17): writes are buffered until the resume. */
  pause: () => void;
  /** Reads the attempt again: the server knows something this client does not. */
  refresh: () => void;
}): StateWrites {
  const base = `/app/api/attempts/${attemptId}`;

  /**
   * A `410` on one of the state writes below means what it means on the
   * autosave: a pause keeps the attempt (D17), the three other reasons end
   * it. The error is rethrown either way, so the button that asked can say
   * its write did not land.
   */
  const post = useCallback(
    async (path: string, body: unknown): Promise<unknown> => {
      try {
        return await api(`${base}/${path}`, { method: "POST", body: JSON.stringify(body) });
      } catch (error) {
        if (error instanceof ApiError && error.status === 410) {
          const reason = (error.body as AttemptClosed | null)?.reason;
          if (reason === "paused") pause();
          else end(reason ?? "deadline");
        }
        throw error;
      }
    },
    [base, end, pause],
  );

  const markDone = useCallback(
    async (itemId: string, done: boolean) => {
      if (closed || preview) {
        dispatch({ type: "done", itemId, done });
        return;
      }
      // Validation locks the question: what the student typed last must be
      // on the server before it closes. If it is not — a failed write whose
      // retry is still pending — the question stays open and the caller says
      // so, rather than locking an older answer for good.
      if (!(await saver.settle(itemId))) throw new UnsavedAnswer();
      const response = MarkDoneResponse.parse(
        await post(`answers/${itemId}/done`, MarkDoneBody.parse({ done })),
      );
      sample(response.serverNow);
      dispatch({ type: "done", itemId, done: response.done });
    },
    [closed, preview, saver, post, sample, dispatch],
  );

  const skip = useCallback(
    async (itemId: string, skipped: boolean) => {
      if (closed) return;
      if (preview) {
        dispatch({ type: "skip", itemId, skipped });
        return;
      }
      // The empty payload that made the question skippable must land BEFORE
      // the skip, or the server still sees the answer it held and refuses.
      if (!(await saver.settle(itemId))) throw new UnsavedAnswer();
      const response = SkipResponse.parse(
        await post(`answers/${itemId}/skip`, SkipBody.parse({ skipped })),
      );
      sample(response.serverNow);
      dispatch({ type: "skip", itemId, skipped: response.skipped });
    },
    [closed, preview, saver, post, sample, dispatch],
  );

  const flag = useCallback(
    async (itemId: string, flagged: boolean) => {
      if (closed) return;
      // Optimistic: a flag is a note to self, and a toggle that lags a round
      // trip behind the click reads as a missed click. Put back on failure.
      dispatch({ type: "flag", itemId, flagged });
      if (preview) return;
      try {
        const response = FlagResponse.parse(
          await post(`answers/${itemId}/flag`, FlagBody.parse({ flagged })),
        );
        sample(response.serverNow);
      } catch (error) {
        dispatch({ type: "flag", itemId, flagged: !flagged });
        throw error;
      }
    },
    [closed, preview, post, sample, dispatch],
  );

  const check = useCallback(
    async (itemId: string, answer: unknown) => {
      if (closed || preview) return;
      // What is checked is what the student last wrote: it must be on the
      // server first, or a pending autosave would land on a locked question.
      if (!(await saver.settle(itemId))) throw new UnsavedAnswer();
      const revision = saver.revisionOf(itemId) + 1;
      let response: CheckResponse;
      try {
        response = CheckResponse.parse(
          await post(
            `answers/${itemId}/check`,
            CheckRequest.parse({
              payload: answer,
              revision,
              clientTs: new Date().toISOString(),
              coordinates: ANSWER_COORDINATES,
            }),
          ),
        );
      } catch (error) {
        // Checked already (another tab): the attempt holds its correction.
        if (refusedWith(error, "item_checked")) refresh();
        throw error;
      }
      sample(response.serverNow);
      saver.seed(itemId, response.revision);
      // A stale revision is not an error: the server checked what it holds.
      if (!response.accepted && response.payload !== undefined) {
        dispatch({ type: "adopt", itemId, payload: response.payload });
      }
      dispatch({ type: "check", itemId, correction: response.correction });
    },
    [closed, preview, saver, post, sample, dispatch, refresh],
  );

  const submit = useCallback(async () => {
    if (!preview) {
      const response = await api<SubmitResponse>(`${base}/submit`, {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      sample(response.serverNow);
    }
    end("submitted");
  }, [base, preview, sample, end]);

  return { markDone, skip, flag, check, submit };
}
