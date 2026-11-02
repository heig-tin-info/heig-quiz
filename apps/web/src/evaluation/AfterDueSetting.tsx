/**
 * "Practice after the due date" on an exercise (ADR-122): once the exercise
 * is over, its students may sit it again as practice, which counts for
 * nothing — not the kept attempt, not the grade, not the statistics.
 *
 * The switch is its own writer (`PUT /evaluations/:id/after-due`), editable at
 * any state, the close and the release included: it opens or hides the
 * practice, nothing a student already did moves. Its value is the effective
 * one (`afterDueOpen`), the default included — open where the feedback
 * policy shows the answer key, off where it stays hidden, since unlimited
 * attempts would give it away — and the server says which
 * (`afterDueSource`); the sub-text explains a default that keeps it off.
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
  // The server's own answer: off by default where the key stays hidden; say why while that default holds.
  const hiddenByDefault = evaluation.afterDueSource === "default" && !evaluation.afterDueOpen;
  return (
    <SettingRow
      title={t("eval.afterDue")}
      desc={hiddenByDefault ? t("eval.afterDue.desc.hiddenKey") : t("eval.afterDue.desc")}
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
