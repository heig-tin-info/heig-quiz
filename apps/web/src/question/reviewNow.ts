import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { QuestionDetail, QuestionReview } from "@quiz/contracts";
import { UNREVIEWED_TYPES } from "@quiz/domain";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { useLlmAvailability } from "../llmAvailability";
import { anyPoolKey, questionKey } from "../queryKeys";

/**
 * "Review now" (ADR-060 §1): the LLM review of the question's latest
 * published version, at the teacher's call. Undefined — no menu entry —
 * without a model, for a reader, before a first publication, or for a type
 * the review does not read.
 */
export function useReviewNow(data: QuestionDetail | undefined, readOnly: boolean): (() => void) | undefined {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const llm = useLlmAvailability();
  const review = useMutation({
    mutationFn: (id: string) => api<QuestionReview>(`/app/api/questions/${id}/review`, { method: "POST" }),
    onSuccess: (result, id) => {
      toast(t(result.state === "findings" ? "review.now.findings" : "review.now.clean"), result.state === "findings" ? "warning" : "success");
      void qc.invalidateQueries({ queryKey: questionKey(id) });
      void qc.invalidateQueries({ queryKey: anyPoolKey });
    },
    onError: (error) => toast(apiErrorMessage(error, t("error.server")), "error"),
  });
  if (!data || llm.data?.available !== true || readOnly || review.isPending) return undefined;
  if (data.latestPublished === null || UNREVIEWED_TYPES.has(data.meta.type)) return undefined;
  return () => review.mutate(data.meta.id);
}
