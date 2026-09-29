/**
 * What a running attempt tells the server on the side: the journal of
 * F-EVAL-13 (visibility, focus, reconnections) and the position of F-LIVE-06,
 * which is also what the server measures the time on each question from
 * (ADR-039).
 * None of it ever blocks the student or surfaces an error, and none of it is
 * sent from the teacher's preview, which has no attempt to write to.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { AttemptEventBody } from "@quiz/contracts";

import { api } from "../api";
import type { Autosave } from "./autosave";

export type Report = (event: AttemptEventBody) => void;

/** F-EVAL-13: the journal. Never blocks, never surfaces an error. */
export function useJournal(attemptId: string, preview: boolean): Report {
  return useCallback<Report>(
    (event) => {
      if (preview) return;
      void api(`/app/api/attempts/${attemptId}/events`, {
        method: "POST",
        body: JSON.stringify(event),
        // The `hidden` entry leaves as the tab goes away: let it outlive it.
        keepalive: true,
      }).catch(() => {
        // A journal entry is never worth interrupting an attempt for.
      });
    },
    [attemptId, preview],
  );
}

/** The browser's own signals: journaled, and `online` replays the answers. */
export function useBrowserSignals(report: Report, saver: Autosave, preview: boolean): void {
  useEffect(() => {
    if (preview) return;
    const onVisibility = () => report({ kind: "visibility", details: { state: document.visibilityState } });
    const onBlur = () => report({ kind: "focus", details: { focused: false } });
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
}

/** Whether the page is on screen: false while the tab is hidden or minimised. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export interface PositionState {
  /** The attempt takes reports: not a preview, not closed, not paused. */
  live: boolean;
  /** The page is on screen ({@link useDocumentVisible}). */
  visible: boolean;
  /** Bumped when the stream comes back: the question is reported again. */
  resend: number;
}

/**
 * F-LIVE-06 and ADR-039: the question on the student's screen, once per move
 * — and `null` when none is (the tab hidden, the player left), so the server,
 * which keeps the time, stops counting. The server's clock times every
 * report; nothing here measures anything.
 *
 * A pause or a close ends the interval on the server by itself, so neither
 * sends `null`; the question is reported again when the attempt resumes, the
 * tab comes back or the stream reopens. A report that failed is forgotten, so
 * the next occasion sends it again.
 */
export function usePosition(attemptId: string, current: string | null, state: PositionState): void {
  const { live, visible, resend } = state;
  const lastPosted = useRef<string | null>(null);
  const lastResend = useRef(resend);
  const liveNow = useRef(live);

  const post = useCallback(
    (itemId: string | null) =>
      api(`/app/api/attempts/${attemptId}/position`, {
        method: "POST",
        body: JSON.stringify({ itemId }),
        // `null` is sent as the page hides or goes away: let it outlive it.
        keepalive: itemId === null,
      }),
    [attemptId],
  );

  useEffect(() => {
    liveNow.current = live;
    if (lastResend.current !== resend) {
      lastResend.current = resend;
      lastPosted.current = null;
    }
    if (!live) {
      // The server closed the interval itself (the pause, the end).
      lastPosted.current = null;
      return;
    }
    if (!visible) {
      if (lastPosted.current === null) return;
      lastPosted.current = null;
      void post(null).catch(() => {
        // The idle cap bounds what a lost `null` can cost (ADR-039).
      });
      return;
    }
    if (current === null || lastPosted.current === current) return;
    lastPosted.current = current;
    void post(current).catch(() => {
      // Losing the bookmark costs a student one click after a reload; the
      // next move, return or reconnection sends it again.
      if (lastPosted.current === current) lastPosted.current = null;
    });
  }, [post, current, live, visible, resend]);

  // Leaving the player while the attempt runs (Home, another page).
  useEffect(
    () => () => {
      if (!liveNow.current || lastPosted.current === null) return;
      lastPosted.current = null;
      void post(null).catch(() => {
        // As above: the idle cap bounds it.
      });
    },
    [post],
  );
}
