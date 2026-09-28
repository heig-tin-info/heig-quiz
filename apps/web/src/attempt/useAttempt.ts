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
 * The rest lives beside it, one concern per file: the state writes
 * (`writes.ts`), the run (`run.ts`), the journal and the position
 * (`signals.ts`).
 *
 * The clock is handed out, never ticked here: `clock` is the server's time
 * as a stable function, and the countdown that shows it re-reads it once a
 * second by itself. A hook that ticked would re-render the whole player —
 * the code editor, the circuit canvas — every second, for one number.
 *
 * Nothing here decides anything the server has not: a lock, a deadline and a
 * closure all come from the API. The client's job is to never offer what the
 * server would refuse, and to never lose what the student wrote.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type {
  AttemptClosed,
  AttemptOrLobby,
  AttemptView,
  AutosaveResponse,
  EvaluationState,
} from "@quiz/contracts";

import { api } from "../api";
import { useEventStream } from "../realtime/useEventStream";
import { useServerClock } from "../realtime/useServerClock";
import { Autosave, type SyncState } from "./autosave";
import {
  emptyPlayerState,
  playerReducer,
  type PlayerAction,
  type PlayerState,
} from "./playerReducer";
import { useAttemptRun, type RunFn } from "./run";
import { useBrowserSignals, useJournal, usePosition, type Report } from "./signals";
import { useStateWrites, type StateWrites } from "./writes";
import { attemptKey } from "../queryKeys";

export { UnsavedAnswer } from "./writes";

/** Why the attempt stopped accepting writes. `null` while it is running. */
interface ClosedInfo {
  reason: AttemptClosed["reason"];
}

export interface UseAttempt extends StateWrites {
  state: PlayerState;
  view: AttemptView | null;
  query: UseQueryResult<AttemptOrLobby>;
  sync: SyncState;
  /**
   * The server's time as best the client knows it — a stable function, read
   * by the countdown on its own tick (`useNow`), never a ticking value.
   */
  clock: () => number;
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
  run: RunFn;
  /** F-EVAL-13: the journal. Never blocks, never surfaces an error. */
  report: Report;
  /**
   * Issue #125: sends every pending answer now. `saved` once the server
   * holds them all; otherwise why not — `unsaved` (a failed write: the
   * network, the server), `paused` (the teacher paused: kept until the
   * resume), `closed` (the attempt ended: they never will be). What leaving
   * the player waits for; it never rejects, and it does not bound the wait.
   */
  flush: () => Promise<FlushResult>;
}

export type FlushResult = "saved" | "unsaved" | "paused" | "closed";

const reasonOfState = (state: AttemptView["attempt"]["state"]): AttemptClosed["reason"] | null =>
  state === "submitted" ? "submitted" : state === "expired" ? "deadline" : null;

/** An evaluation in one of these states takes no more writes from anyone. */
const evaluationOver = (state: EvaluationState) => state === "closed" || state === "grading";

export function useAttempt(attemptId: string, initial?: AttemptView): UseAttempt {
  const [state, dispatch] = useReducer(playerReducer, emptyPlayerState);
  const [sync, setSync] = useState<SyncState>("saved");
  const [closed, setClosed] = useState<ClosedInfo | null>(null);
  const [paused, setPaused] = useState(false);
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
  const { sample, now: clock } = useServerClock();
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

  /** The attempt is over: read-only, and the autosave stops for good. */
  const end = useCallback(
    (reason: AttemptClosed["reason"]) => {
      setClosed({ reason });
      saver.stop();
    },
    [saver],
  );
  const pause = useCallback(() => setPaused(true), []);

  // --- Adopting a fresh view ----------------------------------------------
  useEffect(() => {
    if (!view) return;
    dispatch({ type: "load", view });
    for (const item of view.items) saver.seed(item.id, item.revision);
    sample(view.attempt.serverNow);
    setDeadlineAt(view.attempt.deadlineAt === null ? null : Date.parse(view.attempt.deadlineAt));
    setPaused(view.evaluation.state === "paused");
    const reason = reasonOfState(view.attempt.state);
    if (reason !== null) end(reason);
    else if (evaluationOver(view.evaluation.state)) end("evaluation_closed");
  }, [view, saver, sample, end]);

  const report = useJournal(attemptId, preview);

  // --- The stream ----------------------------------------------------------
  useEventStream({
    enabled: !preview,
    watch: `attempt:${attemptId}`,
    onEvent: (event) => {
      switch (event.type) {
        case "clock":
        case "snapshot":
          // A snapshot is metadata only: arriving while the student types,
          // it must not replace what they typed. The answers come back on a
          // reload.
          sample(event.serverNow);
          break;
        case "attempt.deadline":
          sample(event.serverNow);
          setDeadlineAt(event.deadlineAt === null ? null : Date.parse(event.deadlineAt));
          break;
        case "attempt.closed":
          sample(event.serverNow);
          end(
            event.closedBy === "student"
              ? "submitted"
              : event.closedBy === "teacher"
                ? "evaluation_closed"
                : "deadline",
          );
          break;
        case "evaluation.state":
          sample(event.serverNow);
          if (event.state === "paused") {
            setPaused(true);
          } else if (event.state === "running") {
            setPaused(false);
            // D17: what was buffered during the pause goes out now.
            saver.resume();
          } else if (evaluationOver(event.state)) {
            end("evaluation_closed");
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
      report({ kind: "reconnect" });
      saver.resume();
      void query.refetch();
    },
  });

  useBrowserSignals(report, saver, preview);
  usePosition(attemptId, state.items[state.index]?.id ?? null, !preview && closed === null);

  const setAnswer = useCallback(
    (itemId: string, payload: unknown, answered?: boolean) => {
      if (closed !== null) return;
      dispatch({ type: "answer", itemId, payload, ...(answered === undefined ? {} : { answered }) });
      if (!preview) saver.change(itemId, payload);
    },
    [closed, saver, preview],
  );

  const { markDone, skip, flag, submit } = useStateWrites({
    attemptId,
    preview,
    closed: closed !== null,
    saver,
    sample,
    dispatch,
    end,
    pause,
  });
  const run = useAttemptRun(attemptId);

  const flush = useCallback(async (): Promise<FlushResult> => {
    if (await saver.settleAll()) return "saved";
    const condition = saver.condition;
    return condition === "open" ? "unsaved" : condition;
  }, [saver]);

  return useMemo(
    () => ({
      state,
      view,
      query,
      sync,
      clock,
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
      flush,
    }),
    [
      state,
      view,
      query,
      sync,
      clock,
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
      flush,
    ],
  );
}
