/**
 * Everything the zen player needs, in one hook.
 *
 * It ties together the four things that must agree on a running attempt:
 *   - the state (`playerReducer`), restored from `GET /attempts/:id` so a
 *     reload brings back the answers AND the position (F-LIVE-06);
 *   - the autosave (`Autosave`), which owns every write and the sync badge;
 *   - the server clock, fed by every `serverNow` that comes back — the
 *     attempt view, each autosave response and the `clock` frame the stream
 *     sends every second on a running attempt (invariant 5);
 *   - the stream, which is how a deadline change, a pause and a closure
 *     reach a student who is typing (§4.8).
 *
 * Nothing here decides anything the server has not: a lock, a deadline and a
 * closure all come from the API. The client's job is to never offer what the
 * server would refuse, and to never lose what the student wrote.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  FlagBody,
  FlagResponse,
  MarkDoneBody,
  MarkDoneResponse,
  SkipBody,
  SkipResponse,
  type AttemptClosed,
  type AttemptEventKind,
  type AttemptOrLobby,
  type AttemptView,
  type AutosaveResponse,
  type RunAccepted,
  type RunnerResultEvent,
  type SubmitResponse,
} from "@quiz/contracts";
import type { RunnerOutcome } from "@quiz/core/server";

import { ApiError, api } from "../api";
import { useEventStream } from "../realtime/useEventStream";
import { useServerClock } from "../realtime/useServerClock";
import { Autosave, type SyncState } from "./autosave";
import {
  emptyPlayerState,
  playerReducer,
  type PlayerAction,
  type PlayerState,
} from "./playerReducer";
import { attemptKey } from "../queryKeys";

/** Why the attempt stopped accepting writes. `null` while it is running. */
interface ClosedInfo {
  reason: AttemptClosed["reason"];
}

export interface UseAttempt {
  state: PlayerState;
  view: AttemptView | null;
  query: UseQueryResult<AttemptOrLobby>;
  sync: SyncState;
  /** The server's time, re-read every second. */
  now: number;
  deadlineAt: number | null;
  /** Non-null once the attempt is over: the player turns read-only. */
  closed: ClosedInfo | null;
  /** The teacher pressed pause (decision D17): everything is buffered. */
  paused: boolean;
  dispatch: (action: PlayerAction) => void;
  /**
   * `answered`: the payload holds something (the type's `isAnswered`). The
   * caller knows the type; an answer takes back an "I won't answer".
   */
  setAnswer: (itemId: string, payload: unknown, answered?: boolean) => void;
  /** F-LIVE-08: validate — "Validate and continue", crossing a checkpoint. */
  markDone: (itemId: string, done: boolean) => Promise<void>;
  /** Issue #89: "I won't answer this question", or taking it back. */
  skip: (itemId: string, skipped: boolean) => Promise<void>;
  /** Issue #89: the review flag. */
  flag: (itemId: string, flagged: boolean) => Promise<void>;
  submit: () => Promise<void>;
  run: (
    itemId: string,
    regions: string[],
    /** The free try of §4.7; absent, the server runs the VISIBLE cases. */
    manual?: { args: string[]; stdin: string },
    /** `compileOnly`: the Compile button — build, run nothing, no input. */
    options?: { compileOnly?: boolean | undefined },
  ) => Promise<RunnerOutcome | "unavailable">;
  /** F-EVAL-13: the journal. Never blocks, never surfaces an error. */
  report: (kind: AttemptEventKind, details?: unknown) => void;
}

/** The SSE result shape is not the runner's; the player speaks the latter. */
function toOutcome(result: RunnerResultEvent["result"]): RunnerOutcome | "unavailable" {
  if (result.status === "unavailable" || result.status === "busy") return "unavailable";
  if (result.status === "error") throw new Error(result.message);
  return {
    compile: { ok: result.compile.ok, stdout: "", stderr: result.compile.stderr, ms: 0 },
    // The server sends the VISIBLE cases in their published order, which is
    // the order the player's table walks (deviation W5-12).
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

const reasonOfState = (state: AttemptView["attempt"]["state"]): AttemptClosed["reason"] | null =>
  state === "submitted" ? "submitted" : state === "expired" ? "deadline" : null;

export function useAttempt(attemptId: string, initial?: AttemptView): UseAttempt {
  const [state, dispatch] = useReducer(playerReducer, emptyPlayerState);
  const [sync, setSync] = useState<SyncState>("saved");
  const [closed, setClosed] = useState<ClosedInfo | null>(null);
  const [paused, setPaused] = useState(false);
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
  const clock = useServerClock();
  const sample = clock.sample;
  const serverNow = clock.now;
  const [now, setNow] = useState(() => serverNow());
  const autosave = useRef<Autosave | null>(null);
  const preview = initial?.attempt.preview === true;

  const query = useQuery<AttemptOrLobby>({
    queryKey: attemptKey(attemptId),
    queryFn: () => api<AttemptOrLobby>(`/app/api/attempts/${attemptId}`),
    ...(initial ? { initialData: { kind: "attempt", view: initial } } : {}),
    // The stream is the live channel; this is only the safety net of §6.5.
    refetchInterval: 60_000,
    staleTime: 5_000,
  });
  // The route answers the LOBBY while the evaluation has not started: an
  // attempt id never carries question content by itself (API finding C1).
  // There is nothing to play in that case, and the entry query of
  // `student/Attempt.tsx` is what puts the student back on the lobby screen.
  const view = query.data?.kind === "attempt" ? query.data.view : null;

  // --- The autosave, one per attempt ---------------------------------------
  if (autosave.current === null) {
    autosave.current = new Autosave({
      send: (itemId, body) =>
        api<AutosaveResponse>(`/app/api/attempts/${attemptId}/answers/${itemId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      onState: setSync,
      onAdopt: (itemId, payload) => dispatch({ type: "adopt", itemId, payload }),
      onServerNow: (iso, rttMs) => sample(iso, rttMs),
      onClosed: (info) => {
        if (info?.reason === "paused") {
          setPaused(true);
          return;
        }
        setClosed({ reason: info?.reason ?? "deadline" });
        if (info?.deadlineAt) setDeadlineAt(Date.parse(info.deadlineAt));
      },
    });
  }
  const saver = autosave.current;
  // `start()` on every mount, a NON-final stop on every unmount. StrictMode
  // runs mount → cleanup → mount while keeping the ref, so a stop that could
  // not be undone silenced the autosave for the whole session (the badge kept
  // saying "saved" and no `PUT …/answers/:itemId` ever left the browser).
  useEffect(() => {
    saver.start();
    return () => saver.stop(false);
  }, [saver]);

  // --- Adopting a fresh view ----------------------------------------------
  useEffect(() => {
    if (!view) return;
    dispatch({ type: "load", view });
    for (const item of view.items) saver.seed(item.id, item.revision);
    sample(view.attempt.serverNow);
    setDeadlineAt(view.attempt.deadlineAt === null ? null : Date.parse(view.attempt.deadlineAt));
    setPaused(view.evaluation.state === "paused");
    const reason = reasonOfState(view.attempt.state);
    if (reason !== null) {
      setClosed({ reason });
      saver.stop();
    } else if (view.evaluation.state === "closed" || view.evaluation.state === "grading") {
      setClosed({ reason: "evaluation_closed" });
      saver.stop();
    }
  }, [view, saver, sample]);

  // --- The ticking clock ---------------------------------------------------
  useEffect(() => {
    setNow(serverNow());
    const id = setInterval(() => setNow(serverNow()), 1_000);
    return () => clearInterval(id);
  }, [serverNow]);

  // --- The journal (F-EVAL-13) --------------------------------------------
  const report = useCallback(
    (kind: AttemptEventKind, details?: unknown) => {
      if (preview) return;
      void api(`/app/api/attempts/${attemptId}/events`, {
        method: "POST",
        body: JSON.stringify(details === undefined ? { kind } : { kind, details }),
      }).catch(() => {
        // A journal entry is never worth interrupting an attempt for.
      });
    },
    [attemptId, preview],
  );

  // --- The stream ----------------------------------------------------------
  useEventStream({
    enabled: !preview,
    watch: `attempt:${attemptId}`,
    onEvent: (event) => {
      switch (event.type) {
        case "clock":
          sample(event.serverNow);
          break;
        case "snapshot":
          // Metadata only: a snapshot arriving while the student types must
          // not replace what they typed. The answers come back on a reload.
          sample(event.serverNow);
          break;
        case "attempt.deadline":
          sample(event.serverNow);
          setDeadlineAt(event.deadlineAt === null ? null : Date.parse(event.deadlineAt));
          break;
        case "attempt.closed":
          sample(event.serverNow);
          setClosed({
            reason:
              event.closedBy === "student"
                ? "submitted"
                : event.closedBy === "teacher"
                  ? "evaluation_closed"
                  : "deadline",
          });
          saver.stop();
          break;
        case "evaluation.state":
          sample(event.serverNow);
          if (event.state === "paused") {
            setPaused(true);
          } else if (event.state === "running") {
            setPaused(false);
            // D17: what was buffered during the pause goes out now.
            saver.resume();
          } else if (event.state === "closed" || event.state === "grading") {
            setClosed({ reason: "evaluation_closed" });
            saver.stop();
          }
          break;
        default:
          // The page's one connection carries every frame of the grammar
          // (hints, runner results, lobby counts…); none is the player's.
          break;
      }
    },
    // Not on the first open: only a connection that was lost and came back
    // has answers to replay and a reconnection to journal (F-EVAL-13).
    onReopen: () => {
      report("reconnect");
      saver.resume();
      void query.refetch();
    },
  });

  // --- Browser signals -----------------------------------------------------
  useEffect(() => {
    if (preview) return;
    const onVisibility = () => report("visibility", { state: document.visibilityState });
    const onBlur = () => report("focus", { focused: false });
    const onOnline = () => saver.resume();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("online", onOnline);
    };
  }, [report, saver, preview]);

  // --- The position (F-LIVE-06) -------------------------------------------
  const current = state.items[state.index]?.id ?? null;
  const lastPosted = useRef<string | null>(null);
  useEffect(() => {
    if (preview || current === null || closed !== null) return;
    if (lastPosted.current === current) return;
    lastPosted.current = current;
    void api(`/app/api/attempts/${attemptId}/position`, {
      method: "POST",
      body: JSON.stringify({ itemId: current }),
    }).catch(() => {
      // Losing the bookmark costs a student one click after a reload.
    });
  }, [attemptId, current, closed, preview]);

  const setAnswer = useCallback(
    (itemId: string, payload: unknown, answered?: boolean) => {
      if (closed !== null) return;
      dispatch({ type: "answer", itemId, payload, ...(answered === undefined ? {} : { answered }) });
      if (!preview) saver.change(itemId, payload);
    },
    [closed, saver, preview],
  );

  /**
   * A `410` on one of the state writes below means what it means on the
   * autosave: a pause keeps the attempt (D17), the three other reasons end
   * it. The error is rethrown either way, so the button that asked can say
   * its write did not land.
   */
  const gate = useCallback(
    async <T,>(write: () => Promise<T>): Promise<T> => {
      try {
        return await write();
      } catch (error) {
        if (error instanceof ApiError && error.status === 410) {
          const body = error.body as AttemptClosed | null;
          if (body?.reason === "paused") setPaused(true);
          else {
            setClosed({ reason: body?.reason ?? "deadline" });
            saver.stop();
          }
        }
        throw error;
      }
    },
    [saver],
  );

  const markDone = useCallback(
    async (itemId: string, done: boolean) => {
      if (closed !== null || preview) {
        dispatch({ type: "done", itemId, done });
        return;
      }
      // Validation locks the question: what the student typed last must be
      // on the server before it closes.
      await saver.settle(itemId);
      const response = await gate(() =>
        api<MarkDoneResponse>(`/app/api/attempts/${attemptId}/answers/${itemId}/done`, {
          method: "POST",
          body: JSON.stringify(MarkDoneBody.parse({ done })),
        }),
      );
      sample(MarkDoneResponse.parse(response).serverNow);
      dispatch({ type: "done", itemId, done: response.done });
    },
    [attemptId, closed, preview, sample, saver, gate],
  );

  const skip = useCallback(
    async (itemId: string, skipped: boolean) => {
      if (closed !== null) return;
      if (preview) {
        dispatch({ type: "skip", itemId, skipped });
        return;
      }
      // The empty payload that made the question skippable must land BEFORE
      // the skip, or the server still sees the answer it held and refuses.
      await saver.settle(itemId);
      const response = SkipResponse.parse(
        await gate(() =>
          api(`/app/api/attempts/${attemptId}/answers/${itemId}/skip`, {
            method: "POST",
            body: JSON.stringify(SkipBody.parse({ skipped })),
          }),
        ),
      );
      sample(response.serverNow);
      dispatch({ type: "skip", itemId, skipped: response.skipped });
    },
    [attemptId, closed, preview, sample, saver, gate],
  );

  const flag = useCallback(
    async (itemId: string, flagged: boolean) => {
      if (closed !== null) return;
      // Optimistic: a flag is a note to self, and a toggle that lags a round
      // trip behind the click reads as a missed click. Put back on failure.
      dispatch({ type: "flag", itemId, flagged });
      if (preview) return;
      try {
        const response = FlagResponse.parse(
          await gate(() =>
            api(`/app/api/attempts/${attemptId}/answers/${itemId}/flag`, {
              method: "POST",
              body: JSON.stringify(FlagBody.parse({ flagged })),
            }),
          ),
        );
        sample(response.serverNow);
      } catch (error) {
        dispatch({ type: "flag", itemId, flagged: !flagged });
        throw error;
      }
    },
    [attemptId, closed, preview, sample, gate],
  );

  const submit = useCallback(async () => {
    if (preview) {
      setClosed({ reason: "submitted" });
      return;
    }
    const response = await api<SubmitResponse>(
      `/app/api/attempts/${attemptId}/submit`,
      { method: "POST", body: JSON.stringify({ confirm: true }) },
    );
    sample(response.serverNow);
    setClosed({ reason: "submitted" });
    saver.stop();
  }, [attemptId, preview, sample, saver]);

  /*
   * The BACKEND half of a student's "Run" (ADR-015). Which runner serves the
   * run is decided one level up, in `src/runner/`: `student/Player.tsx` hands
   * this function to `runCode` as the backend path, and the browser runner
   * takes over when the question asks for it or when this one answers 503.
   * Nothing about the call below changed, and nothing about it should: a
   * graded run is this one.
   */
  const run = useCallback(
    async (
      itemId: string,
      regions: string[],
      manual?: { args: string[]; stdin: string },
      options?: { compileOnly?: boolean | undefined },
    ): Promise<RunnerOutcome | "unavailable"> => {
      try {
        const response = await api<RunAccepted>(
          `/app/api/attempts/${attemptId}/run`,
          {
            method: "POST",
            // A `stdin` — even an empty one — is what tells the server this is
            // the free try rather than the visible cases (`RunBody`);
            // `compileOnly` is the Compile button, which takes no input.
            body: JSON.stringify(
              options?.compileOnly === true
                ? { itemId, regions, compileOnly: true }
                : manual === undefined
                  ? { itemId, regions }
                  : { itemId, regions, stdin: manual.stdin, args: manual.args },
            ),
          },
        );
        return toOutcome(response.result);
      } catch (error) {
        // 503 is a configuration, not a failure (decision D14): the player
        // says so in one line and the answer is still saved and still graded.
        if (error instanceof ApiError && (error.status === 503 || error.status === 429)) {
          return "unavailable";
        }
        throw error;
      }
    },
    [attemptId],
  );

  return useMemo(
    () => ({
      state,
      view,
      query,
      sync,
      now,
      deadlineAt,
      closed,
      paused,
      dispatch,
      setAnswer,
      markDone,
      skip,
      flag,
      submit,
      run,
      report,
    }),
    [
      state,
      view,
      query,
      sync,
      now,
      deadlineAt,
      closed,
      paused,
      setAnswer,
      markDone,
      skip,
      flag,
      submit,
      run,
      report,
    ],
  );
}
