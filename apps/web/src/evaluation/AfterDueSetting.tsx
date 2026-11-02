/**
 * "Practice after the due date" on an exercise (ADR-122): once the exercise
 * is over, its students may sit it again as practice, which counts for
 * nothing — not the kept attempt, not the grade, not the statistics.
 *
 * The switch is its own writer (`PUT /evaluations/:id/after-due`), editable at
 * any state, the close and the release included: it opens or hides the
 * practice, nothing a student already did moves. Its value is the effective
 * one (`afterDueOpen`), the default included: open, but off under the
 * feedback policy `none`, where the points of unlimited attempts would give
 * the answer key away — the sub-text says so while that default holds.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { EvaluationAfterDueBody, type EvaluationDetail } from "@quiz/contracts";

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
  const set = useMutation({
    mutationFn: (open: boolean) =>
      api<EvaluationDetail>(`/app/api/evaluations/${evaluation.id}/after-due`, {
        method: "PUT",
        body: JSON.stringify(EvaluationAfterDueBody.parse({ afterDue: open ? "open" : "hidden" })),
      }),
    onSuccess: (next) => qc.setQueryData(evaluationKey(evaluation.id), next),
    onError: toastError("eval.afterDue.failed"),
  });
  // The default under the policy `none` is off: say why, while it holds.
  const noneDefault = evaluation.settings.afterDue === undefined && evaluation.feedbackPolicy.when === "none";
  return (
    <SettingRow
      title={t("eval.afterDue")}
      desc={noneDefault ? t("eval.afterDue.desc.none") : t("eval.afterDue.desc")}
    >
      <Switch
        checked={evaluation.afterDueOpen}
        disabled={set.isPending}
        label={t("eval.afterDue")}
        onChange={(next) => set.mutate(next)}
      />
    </SettingRow>
  );
}
