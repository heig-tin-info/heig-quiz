import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { GradingProgress } from "@quiz/contracts";

import { api } from "../api";
import { gradingKey, gradingProgressKey } from "../queryKeys";
import { useEventStream } from "../realtime/useEventStream";

/**
 * How far the automatic pass has got (`GET …/grading/progress`).
 *
 * Two sources, on purpose. The plain hint channel of `live.ts` already
 * invalidates every query when the server says something changed, which is
 * what refreshes the queue itself. `grading.progress` is a NAMED frame
 * (deviation W5-7), so the panel watches the evaluation on the page's shared
 * connection and writes the payload straight into the cache: a progress bar
 * that only moves on a hint would stand still through the whole pass.
 */
export function useGradingProgress(evaluationId: string) {
  const qc = useQueryClient();
  const query = useQuery<GradingProgress>({
    queryKey: gradingProgressKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/grading/progress`),
  });

  useEventStream({
    watch: `evaluation:${evaluationId}`,
    onEvent: (event) => {
      if (event.type !== "grading.progress" || event.evaluationId !== evaluationId) return;
      qc.setQueryData<GradingProgress>(gradingProgressKey(evaluationId), (previous) => ({
        done: event.done,
        total: event.total,
        pending: previous?.pending ?? { runner: 0, llm: 0 },
        failed: previous?.failed ?? 0,
      }));
      // The last frame of a pass: the entries themselves are now stale.
      if (event.phase === "done") {
        void qc.invalidateQueries({ queryKey: gradingKey(evaluationId) });
      }
    },
  });

  return query;
}
