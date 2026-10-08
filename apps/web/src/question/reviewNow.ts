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
 * published version, at the teacher's call, from the editor's AI card
 * (ADR-082). Undefined — not offered — without a model, for a reader, before
 * a first publication, or for a type the review does not read.
 *
 * `review` is what the card shows: the call's own result as soon as it lands
 * (no wait for the refetch, no empty flash), else the stored review of the
 * latest published version. The result says it all, so success raises no
 * toast; a failure does.
 */
export function useReviewNow(
  data: QuestionDetail,
  readOnly: boolean,
): { run: () => void; pending: boolean; review: QuestionReview | null } | undefined {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const llm = useLlmAvailability();
  const call = useMutation({
    mutationFn: (id: string) => api<QuestionReview>(`/app/api/questions/${id}/review`, { method: "POST" }),
    onSuccess: (_result, id) => {
      void qc.invalidateQueries({ queryKey: questionKey(id) });
      void qc.invalidateQueries({ queryKey: anyPoolKey });
    },
    onError: (error) => toast(apiErrorMessage(error, t("error.server")), "error"),
  });
  if (llm.data?.available !== true || readOnly) return undefined;
  const latest = data.latestPublished;
  if (latest === null || UNREVIEWED_TYPES.has(data.meta.type)) return undefined;
  // A result of a version since superseded by a publication is not this one's.
  const fresh = call.data && call.data.versionNumber === latest.number ? call.data : null;
  return {
    run: () => call.mutate(data.meta.id),
    pending: call.isPending,
    review: fresh ?? data.review,
  };
}
