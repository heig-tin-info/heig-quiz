import { useQuery } from "@tanstack/react-query";

import type { AttemptInspect } from "@quiz/contracts";

import { api } from "../api";
import { attemptInspectKey } from "../queryKeys";

/**
 * How long a student's paper is trusted without asking again. Short on
 * purpose, and not what keeps it FRESH: `useDashboard` invalidates the entry
 * the moment a `dashboard.cell` frame says that student wrote something. The
 * staleTime only spares the server a request per cell while the pointer
 * travels along one row of the grid, each cell's tooltip reading the same
 * attempt.
 */
export const INSPECT_STALE_MS = 10_000;

/**
 * One student's whole paper (`GET …/attempts/:attemptId`), the query behind
 * both the inspection modal and the tooltip of a grid cell (#94). ONE key,
 * so the two share the cache: a tooltip read on the way to a click makes the
 * modal open with its content already there.
 */
export function useAttemptInspect(
  evaluationId: string,
  attemptId: string | null,
  enabled = true,
) {
  return useQuery<AttemptInspect>({
    queryKey: attemptInspectKey(evaluationId, attemptId),
    enabled: enabled && attemptId !== null,
    staleTime: INSPECT_STALE_MS,
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/attempts/${attemptId}`),
  });
}
