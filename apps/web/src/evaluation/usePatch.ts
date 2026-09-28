import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { EvaluationDetail, EvaluationPatch, TemplateDetail, TemplatePatch } from "@quiz/contracts";

import { api } from "../api";
import { courseTemplatesKey, evaluationKey, templateKey } from "../queryKeys";

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

/**
 * The same writer for a template's editor (F-EVAL-25): `PATCH /templates/:id`
 * answers the whole `TemplateDetail`, revision included, which replaces the
 * cache; the course page's row (its revision, its title) is refreshed too.
 */
export function useTemplatePatch(id: string, courseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TemplatePatch) =>
      api<TemplateDetail>(`/app/api/templates/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: async (detail) => {
      qc.setQueryData(templateKey(id), detail);
      await qc.invalidateQueries({ queryKey: courseTemplatesKey(courseId) });
    },
  });
}
