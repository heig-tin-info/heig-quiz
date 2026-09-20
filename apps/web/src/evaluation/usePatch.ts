import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { EvaluationDetail, EvaluationPatch } from "@quiz/contracts";

import { api } from "../api";
import { evaluationKey } from "./common";

/**
 * The one writer of the configuration screen. Every control on the three
 * steps sends the same `PATCH /evaluations/:id` and the answer is the whole
 * `EvaluationDetail`, so the cache is replaced rather than invalidated: the
 * screen never blinks between the click and the refetch, and a `409 locked`
 * leaves the previous value on screen, which is what it still is.
 */
export function useEvaluationPatch(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EvaluationPatch) =>
      api<EvaluationDetail>(`/app/api/evaluations/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (detail) => qc.setQueryData(evaluationKey(id), detail),
  });
}
