/**
 * The student's half of the SSE stream (PLAN-MVP §4.8), deliberately minimal.
 *
 * WP8 owns the general `realtime/useEventStream.ts` that seeds query caches
 * for the teacher dashboard. The player needs something smaller and with a
 * different failure story: four named frames, a reconnection signal, and no
 * cache writes at all — the attempt state lives in `useAttempt`, and a
 * snapshot that overwrote it would throw away what the student is typing.
 * The supervisor unifies the two once both have landed.
 *
 * The server sends every typed event as a NAMED frame (`event: clock`, …) and
 * the inherited refresh hint as an unnamed one, so this client subscribes by
 * name and never sees the hints (deviation W5-7 of PLAN-MVP).
 */
import { useEffect, useRef } from "react";

import { ServerEvent } from "@quiz/contracts";

/**
 * The two subjects a student watches: their attempt, or the lobby.
 *
 * `lobby:` and not `evaluation:` — the two carry the same topic and the same
 * authorisation, and the subject is what tells the server which side of the
 * room the connection is on. Only a `lobby:` (or one's own `attempt:`) counts
 * as PRESENT, which is what lets a teacher who holds a roster seat and walks
 * their own quiz be a body in the room like anybody else (ADR-018).
 */
export type WatchSubject = `attempt:${string}` | `lobby:${string}`;

/** The frames the player and the lobby act on. Nothing else is subscribed. */
const WATCHED_EVENTS = [
  "snapshot",
  "clock",
  "evaluation.state",
  "attempt.deadline",
  "attempt.closed",
  "lobby.count",
  "runner.result",
] as const;

export interface StreamHandlers {
  onEvent: (event: ServerEvent) => void;
  /** First successful open. */
  onOpen?: () => void;
  /**
   * An open that follows a drop. EventSource reconnects by itself; this is
   * where the unacked answers are replayed and the `reconnect` attempt event
   * is journalled (F-EVAL-13).
   */
  onReconnect?: () => void;
  onError?: () => void;
}

/**
 * Opens the stream and returns the closer. Safe where `EventSource` does not
 * exist (jsdom): it does nothing and says so by returning a no-op.
 */
function openAttemptStream(watch: WatchSubject, handlers: StreamHandlers): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource(`/app/api/events?watch=${encodeURIComponent(watch)}`);
  let dropped = false;
  const onNamed = (raw: MessageEvent) => {
    let data: unknown;
    try {
      data = JSON.parse(raw.data as string);
    } catch {
      return;
    }
    // A malformed frame is dropped, never rendered: the countdown and the
    // "time is up" screen both hang off this stream.
    const parsed = ServerEvent.safeParse(data);
    if (parsed.success) handlers.onEvent(parsed.data);
  };
  for (const name of WATCHED_EVENTS) source.addEventListener(name, onNamed as EventListener);
  source.onopen = () => {
    if (dropped) {
      dropped = false;
      handlers.onReconnect?.();
    } else {
      handlers.onOpen?.();
    }
  };
  source.onerror = () => {
    dropped = true;
    handlers.onError?.();
  };
  return () => {
    for (const name of WATCHED_EVENTS) source.removeEventListener(name, onNamed as EventListener);
    source.close();
  };
}

/**
 * The hook form. The handlers are kept in a ref so a re-render (every second,
 * on a screen with a countdown) never reopens the stream.
 */
export function useAttemptStream(watch: WatchSubject | null, handlers: StreamHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (watch === null) return;
    return openAttemptStream(watch, {
      onEvent: (e) => latest.current.onEvent(e),
      onOpen: () => latest.current.onOpen?.(),
      onReconnect: () => latest.current.onReconnect?.(),
      onError: () => latest.current.onError?.(),
    });
  }, [watch]);
}
