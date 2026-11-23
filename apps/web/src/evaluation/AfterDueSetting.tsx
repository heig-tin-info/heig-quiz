/**
 * "Practice after the due date" on an exercise (ADR-122) or an exam
 * (ADR-142): once the exercise is over, or the exam's results released, its
 * students may sit it again as practice, which counts for nothing — not the
 * kept attempt, not the grade, not the statistics. An exam's is closed by
 * default, and opens only under a stored feedback policy that shows the
 * answer and the key at the release (`examPracticeFeedbackOk`): otherwise
 * the switch is disabled and says why, as the server would refuse it
 * (`422 practice_key_hidden`).
 *
 * The switch is its own writer (`PUT /evaluations/:id/after-due`), editable at
 * any state, the close and the release included: it opens or hides the
 * practice, nothing a student already did moves. Its value is the effective
 * one (`afterDueOpen`), the default included — open, since every exercise
 * shows its answer key at the hand-in (ADR-124).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { EvaluationAfterDueBody, type EvaluationDetail } from "@quiz/contracts";
import { examPracticeFeedbackOk } from "@quiz/domain";

import { api } from "../api";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { evaluationKey } from "../queryKeys";
import { SettingRow, Switch } from "../ui";

export function AfterDueSetting({ detail }: { detail: EvaluationDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const { evaluation } = detail;
  const exam = evaluation.mode === "exam";
  const keyHidden = exam && !evaluation.afterDueOpen && !examPracticeFeedbackOk(evaluation.feedbackPolicy);
  const set = useMutation({
    mutationFn: (open: boolean) =>
      api<EvaluationDetail>(`/app/api/evaluations/${evaluation.id}/after-due`, {
        method: "PUT",
        body: JSON.stringify(EvaluationAfterDueBody.parse({ afterDue: open ? "open" : "hidden" })),
      }),
    onSuccess: (next) => qc.setQueryData(evaluationKey(evaluation.id), next),
    onError: toastError("eval.afterDue.failed"),
  });
  return (
    <SettingRow
      title={t("eval.afterDue")}
      desc={t(keyHidden ? "eval.afterDue.keyHidden" : exam ? "eval.afterDue.exam.desc" : "eval.afterDue.desc")}
    >
      <Switch
        checked={evaluation.afterDueOpen}
        disabled={set.isPending || keyHidden}
        label={t("eval.afterDue")}
        onChange={(next) => set.mutate(next)}
      />
    </SettingRow>
  );
}
