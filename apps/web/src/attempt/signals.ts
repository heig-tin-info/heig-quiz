/**
 * What a running attempt tells the server on the side: the journal of
 * F-EVAL-13 (visibility, focus, reconnections) and the position of F-LIVE-06.
 * None of it ever blocks the student or surfaces an error, and none of it is
 * sent from the teacher's preview, which has no attempt to write to.
 */
import { useCallback, useEffect, useRef } from "react";

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

/** F-LIVE-06: the question the student is on, once per move, while it runs. */
export function usePosition(
  attemptId: string,
  current: string | null,
  active: boolean,
): void {
  const lastPosted = useRef<string | null>(null);
  useEffect(() => {
    if (!active || current === null) return;
    if (lastPosted.current === current) return;
    lastPosted.current = current;
    void api(`/app/api/attempts/${attemptId}/position`, {
      method: "POST",
      body: JSON.stringify({ itemId: current }),
    }).catch(() => {
      // Losing the bookmark costs a student one click after a reload.
    });
  }, [attemptId, current, active]);
}
