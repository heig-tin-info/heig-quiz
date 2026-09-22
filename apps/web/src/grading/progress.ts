import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { GradingProgress, GradingProgressEvent } from "@quiz/contracts";

import { api } from "../api";

/**
 * How far the automatic pass has got (`GET …/grading/progress`).
 *
 * Two sources, on purpose. The plain hint channel of `live.ts` already
 * invalidates every query when the server says something changed, which is
 * what refreshes the queue itself. `grading.progress` is a NAMED frame, and
 * `EventSource.onmessage` never sees a named one (deviation W5-7), so the
 * panel opens its own reader for that one event and writes the payload
 * straight into the cache: a progress bar that only moves on a hint would
 * stand still through the whole pass.
 *
 * It is deliberately NOT a general stream hook — one event, one query, one
 * screen. The shared `useEventStream` belongs to the live dashboard.
 */
function gradingProgressKey(evaluationId: string) {
  return ["grading", evaluationId, "progress"] as const;
}

export function useGradingProgress(evaluationId: string) {
  const qc = useQueryClient();
  const query = useQuery<GradingProgress>({
    queryKey: gradingProgressKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/grading/progress`),
  });

  useEffect(() => {
    // jsdom (and a very old browser) has no EventSource at all; the panel
    // still works, it just stops moving on its own.
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(
      `/app/api/events?watch=${encodeURIComponent(`evaluation:${evaluationId}`)}`,
    );
    // The browser mock swaps EventSource for a stub that emits nothing; a
    // screen must not crash because the stand-in has no listener support.
    if (typeof source.addEventListener !== "function") {
      source.close?.();
      return;
    }
    const onProgress = (e: MessageEvent<string>) => {
      let event: GradingProgressEvent;
      try {
        event = JSON.parse(e.data) as GradingProgressEvent;
      } catch {
        return;
      }
      if (event.evaluationId !== evaluationId) return;
      qc.setQueryData<GradingProgress>(gradingProgressKey(evaluationId), (previous) => ({
        done: event.done,
        total: event.total,
        pending: previous?.pending ?? { runner: 0, llm: 0 },
        failed: previous?.failed ?? 0,
      }));
      // The last frame of a pass: the entries themselves are now stale.
      if (event.phase === "done") {
        void qc.invalidateQueries({ queryKey: ["grading", evaluationId] });
      }
    };
    source.addEventListener("grading.progress", onProgress as EventListener);
    return () => {
      source.removeEventListener("grading.progress", onProgress as EventListener);
      source.close();
    };
  }, [evaluationId, qc]);

  return query;
}
