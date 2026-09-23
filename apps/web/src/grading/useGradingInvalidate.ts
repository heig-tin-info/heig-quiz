import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { gradingKey, resultsKey } from "../queryKeys";

/**
 * What every grading write makes stale: the grading reads of the evaluation
 * (queue, roster, progress) and its results (table, per-question view), which
 * are computed from the same gradings. Both invalidations are fire-and-forget,
 * as they were at each of the call sites this replaces: the caller toasts and
 * closes at once, and the lists refetch behind it.
 */
export function useGradingInvalidate(evaluationId: string): () => void {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: gradingKey(evaluationId) });
    void qc.invalidateQueries({ queryKey: resultsKey(evaluationId) });
  }, [qc, evaluationId]);
}
