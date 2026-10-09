/**
 * The staff's reads of the evaluations, the key, the URL and the type in one
 * place for every screen that shares them: a classroom's list (its tab count
 * and its rows), one evaluation (configuration, live dashboard, grading,
 * results, preview, question editor), one template, and the results by
 * question (the results tab and the correction's projection). A student never
 * reads them: their attempt and feedback are their own routes.
 */
import { useQuery } from "@tanstack/react-query";

import type { ByQuestion, EvaluationDetail, EvaluationSummary, TemplateDetail } from "@quiz/contracts";

import { api, type ReadOptions } from "../api";
import { evaluationKey, evaluationsKey, resultsByQuestionKey, templateKey } from "../queryKeys";

/** `GET /classrooms/:id/evaluations`. */
export function useEvaluations(classroomId: string) {
  return useQuery<EvaluationSummary[]>({
    queryKey: evaluationsKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}/evaluations`),
  });
}

/** `GET /evaluations/:id`; `null` while the id is not known yet: the query waits. */
export function useEvaluation(id: string | null, options: ReadOptions = {}) {
  return useQuery<EvaluationDetail>({
    queryKey: evaluationKey(id ?? ""),
    queryFn: () => api(`/app/api/evaluations/${id}`),
    ...options,
    enabled: id !== null && (options.enabled ?? true),
  });
}

/** `GET /templates/:id` (ADR-031); `null` while the id is not known yet: the query waits. */
export function useTemplate(id: string | null, options: ReadOptions = {}) {
  return useQuery<TemplateDetail>({
    queryKey: templateKey(id ?? ""),
    queryFn: () => api(`/app/api/templates/${id}`),
    ...options,
    enabled: id !== null && (options.enabled ?? true),
  });
}

/** `GET /evaluations/:id/results/by-question`. */
export function useResultsByQuestion(evaluationId: string, options: ReadOptions = {}) {
  return useQuery<ByQuestion[]>({
    queryKey: resultsByQuestionKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/results/by-question`),
    ...options,
  });
}
