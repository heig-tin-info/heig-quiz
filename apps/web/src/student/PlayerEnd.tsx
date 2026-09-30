import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  retakesOf,
  type AttemptClosed,
  type AttemptView,
  type StudentFeedback,
} from "@quiz/contracts";
import { retakesOn } from "@quiz/domain";

import { api } from "../api";
import { useT } from "../i18n";
import { attemptFeedbackKey } from "../queryKeys";
import { Spinner } from "../ui";
import { ClosedScreen } from "./ClosedScreen";
import type { OnResults } from "./Player";

/** How long a kiosk station shows the closed screen before its own screen (ADR-051 §7). */
export const STATION_END_MS = 8_000;

/**
 * What the player becomes once the attempt is over — handed in, its time
 * up, or the evaluation closed. The session decided it, from the server;
 * this only shows it.
 *
 * F-EVAL-15 (issue #121, ADR-025): on an exercise that takes retakes, the
 * end of an attempt — handed in, or its time up — opens the score at once.
 * The hand-in screen's "your answers are with your teacher" is wrong there:
 * the student reads the score now and decides whether to try again, and that
 * page carries the Retake. A teacher's close is not such an end (no retake
 * follows it), and an exam keeps its hand-in screen.
 */
export function PlayerEnd({
  reason,
  initial,
  onHome,
  onResults,
  station = false,
}: {
  reason: AttemptClosed["reason"];
  initial: AttemptView;
  onHome: () => void;
  onResults?: OnResults | undefined;
  /**
   * Sat on a kiosk station (ADR-051 §7): its session ended with the attempt,
   * so nothing more can be read from here. The closed screen stays a few
   * seconds, drawn from what the page already holds, then `onHome` takes the
   * station back to its own screen.
   */
  station?: boolean;
}) {
  const t = useT();
  const preview = initial.attempt.preview;
  const retakes =
    !preview && !station && retakesOn(initial.evaluation.mode, retakesOf(initial.evaluation.settings));
  const toResults =
    retakes && onResults !== undefined && (reason === "submitted" || reason === "deadline");
  const forwarded = useRef(false);
  useEffect(() => {
    if (!toResults || forwarded.current) return;
    forwarded.current = true;
    onResults(initial.attempt.id, { replace: true });
  }, [toResults, onResults, initial.attempt.id]);

  // Issue #203: "See my results" only when the feedback page has something
  // to show (`immediate`). The page's own route answers, so the rule stays
  // the server's one; the answer also warms the page it leads to. A teacher
  // preview has no attempt of its own, so nothing is asked for it.
  const asked = !preview && !station && onResults !== undefined && !toResults;
  const feedback = useQuery<StudentFeedback>({
    queryKey: attemptFeedbackKey(initial.attempt.id),
    queryFn: () => api(`/app/api/attempts/${initial.attempt.id}/feedback`),
    enabled: asked,
    retry: false,
  });

  // The latest `onHome`, so that a parent's re-render does not restart the wait.
  const home = useRef(onHome);
  home.current = onHome;
  useEffect(() => {
    if (!station) return;
    const id = setTimeout(() => home.current(), STATION_END_MS);
    return () => clearTimeout(id);
  }, [station]);

  if (toResults) return <Spinner label={t("player.loading")} className="py-24" />;
  return (
    <ClosedScreen
      reason={reason}
      title={initial.evaluation.title}
      onHome={onHome}
      {...(station ? { note: t("kiosk.returning") } : {})}
      // Held until the answer settles; an error leaves Back to home alone.
      actionsHeld={asked && feedback.isLoading}
      {...(asked && feedback.data?.available === true
        ? { onResults: () => onResults(initial.attempt.id) }
        : {})}
    />
  );
}
