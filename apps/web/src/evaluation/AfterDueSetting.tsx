/**
 * "Practice after the due date" on an exercise (ADR-122) or an exam
 * (ADR-142): once the exercise is over, or the exam's results released, its
 * students may sit it again as practice, which counts for nothing — not the
 * kept attempt, not the grade, not the statistics. An exam's is closed by
 * default, and opens only under a stored feedback policy that shows the key
 * at the release (`practiceKeyShown`): otherwise turning it on is disabled
 * and says why, as the server would refuse it (`422 practice_key_hidden`).
 * A practice opened before the key was hidden is SUSPENDED, not closed: the
 * switch shows the stored `open`, says so, and stays usable to close it;
 * showing the key again reopens it.
 *
 * The switch is its own writer (`PUT /evaluations/:id/after-due`), editable at
 * any state, the close and the release included: it opens or hides the
 * practice, nothing a student already did moves. Its value is the effective
 * one (`afterDueOpen`), the default included — open, since every exercise
 * shows its answer key at the hand-in (ADR-124).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { EvaluationAfterDueBody, type EvaluationDetail } from "@quiz/contracts";
import { afterDueSettingOf, practiceKeyShown, practicePolicyOf } from "@quiz/domain";

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
  const policy = practicePolicyOf(evaluation.mode);
  // A released exam's wording: its practice is only for those who took it.
  // The policy table decides, never a test of the mode.
  const takersOnly = policy?.needsTaken === true;
  const keyHidden = policy?.needsKeyShown === true && !practiceKeyShown(evaluation.feedbackPolicy);
  // Opened, then the key hidden: the practice waits for the key, the switch
  // stays on and may still close it. Turning it on waits for the key.
  const suspended = keyHidden && afterDueSettingOf(evaluation.mode, evaluation.settings.afterDue) === "open";
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
      desc={t(
        suspended
          ? "eval.afterDue.suspended"
          : keyHidden
            ? "eval.afterDue.keyHidden"
            : takersOnly
              ? "eval.afterDue.exam.desc"
              : "eval.afterDue.desc",
      )}
    >
      <Switch
        checked={evaluation.afterDueOpen || suspended}
        disabled={set.isPending || (keyHidden && !suspended)}
        label={t("eval.afterDue")}
        onChange={(next) => set.mutate(next)}
      />
    </SettingRow>
  );
}
