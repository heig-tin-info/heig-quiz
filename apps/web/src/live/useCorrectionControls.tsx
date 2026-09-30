import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  retakesOf,
  type Evaluation,
  type PublishCorrectionBody,
  type PublishCorrectionResponse,
} from "@quiz/contracts";
import { correctionPublishRefusal } from "@quiz/domain";

import { ApiError, api } from "../api";
import { useConfirm } from "../confirm";
import { useT, type Dict } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { resultsKey } from "../queryKeys";
import type { Route } from "../router";
import type { CorrectionControls } from "./LiveHeader";

/**
 * What a student will read once the correction is published (ADR-050): the
 * feedback policy decides, as at a release — `none` shows nothing, and the
 * key only travels under `showKey`.
 */
function studentsLine(policy: Evaluation["feedbackPolicy"]): keyof Dict {
  if (policy.when === "none") return "live.correction.confirm.students.none";
  return policy.showKey
    ? "live.correction.confirm.students.key"
    : "live.correction.confirm.students.noKey";
}

/**
 * "Publish the correction" of a running exercise (ADR-050): the confirmation
 * that says what happens under THIS evaluation's feedback policy, the call,
 * and "Present" once it is done. `null` wherever the server refuses it
 * (`correctionPublishRefusal`, the server's own rule: an exam, a poll, an
 * exercise that is not running) and until the evaluation has loaded.
 */
export function useCorrectionControls({
  id,
  evaluation,
  navigate,
  onChanged,
}: {
  /** The route's id: the one the dashboard's queries are keyed on. */
  id: string;
  evaluation: Evaluation | undefined;
  navigate: (r: Route) => void;
  /** Re-reads the evaluation and the grid: the badge, the menu and Reopen follow. */
  onChanged: () => void;
}): CorrectionControls | null {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();

  const publish = useMutation<PublishCorrectionResponse>({
    mutationFn: () =>
      api(`/app/api/evaluations/${id}/publish-correction`, {
        method: "POST",
        body: JSON.stringify({ confirm: true } satisfies PublishCorrectionBody),
      }),
    onSuccess: () => {
      onChanged();
      void qc.invalidateQueries({ queryKey: resultsKey(id) });
      toast(t("live.correction.done"), "success");
    },
    onError: (error) => {
      toastError("live.correction.failed")(error);
      // Closed meanwhile (409): the evaluation read again takes the item away.
      if (error instanceof ApiError && error.status === 409) onChanged();
    },
  });

  if (!evaluation || correctionPublishRefusal(evaluation) !== null) return null;

  const ask = async () => {
    const ok = await confirm({
      title: t("live.correction.confirm.title", { title: evaluation.title }),
      message: (
        <div className="space-y-2">
          <p>
            {t(
              retakesOf(evaluation.settings).enabled
                ? "live.correction.confirm.openRetakes"
                : "live.correction.confirm.open",
            )}
          </p>
          <p>{t("live.correction.confirm.projection")}</p>
          <p>{t(studentsLine(evaluation.feedbackPolicy))}</p>
          <p className="font-medium text-fg">{t("live.correction.confirm.final")}</p>
        </div>
      ),
      confirmLabel: t("live.correction.publish"),
      cancelLabel: t("common.cancel"),
    });
    if (ok) publish.mutate();
  };

  return {
    published: evaluation.correctionPublishedAt !== null,
    publish: () => void ask(),
    present: () => navigate({ view: "correction", evaluationId: id }),
  };
}
