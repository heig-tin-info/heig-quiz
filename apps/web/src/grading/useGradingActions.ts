import { useMutation } from "@tanstack/react-query";
import { BarChart3, CheckCheck, RefreshCcw } from "lucide-react";

import type { BatchValidateBody, BatchValidateResponse, GradingRunBody } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import { useScreenCommands } from "../screenCommands";
import { gradingLinks } from "./index";
import { useGradingInvalidate } from "./useGradingInvalidate";

/** Above this many, a batch stops being a gesture and becomes a decision. */
const BATCH_CONFIRM_THRESHOLD = 10;

/** What a batch validates: the proposals of one question the filters show. */
export type BatchScope = Omit<BatchValidateBody, "state">;

/**
 * What the grading screen does, as opposed to what it shows: validate one
 * proposal or a batch of them, run the grading pass, and the palette
 * commands of the screen (open the results, run the pass, re-grade the
 * question at hand).
 *
 * The batch is the screen's one accent action (F-GRADE-04). Above ten it
 * goes through `useConfirm`, because forty grades moving at once is not
 * something to discover afterwards.
 *
 * `onRegrade` opens the re-grade sheet of the question on screen, the one a
 * palette "re-grade" means. The pass runs on one question from the screen
 * (`run.mutate([itemId])`) and on the whole evaluation from the palette.
 */
export function useGradingActions({
  evaluationId,
  navigate,
  onRegrade,
}: {
  evaluationId: string;
  navigate: (r: Route) => void;
  /** Absent while no question is on screen. */
  onRegrade: (() => void) | undefined;
}) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();
  const invalidate = useGradingInvalidate(evaluationId);

  const batch = useMutation<BatchValidateResponse, unknown, BatchScope>({
    mutationFn: (scope) =>
      api(`/app/api/evaluations/${evaluationId}/grading/validate-batch`, {
        method: "POST",
        body: JSON.stringify({ ...scope, state: "proposed" } satisfies BatchValidateBody),
      }),
    onSuccess: (result) => {
      invalidate();
      toast(t("grading.batch.done", { n: result.validated }), "success");
    },
    onError: toastError("grading.batch.failed"),
  });
  const validateBatch = async (scope: BatchScope, n: number) => {
    if (n > BATCH_CONFIRM_THRESHOLD) {
      const ok = await confirm({
        title: t("grading.batch.confirm.title", { n }),
        message: t("grading.batch.confirm.body", { n }),
        confirmLabel: t("grading.batch.confirm.ok"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
    }
    batch.mutate(scope);
  };

  const validate = useMutation({
    mutationFn: (gradingId: string) =>
      api(`/app/api/gradings/${gradingId}/validate`, { method: "POST", body: "{}" }),
    onSuccess: invalidate,
    onError: toastError("grading.validate.failed"),
  });

  const run = useMutation<unknown, unknown, string[] | undefined>({
    mutationFn: (itemIds) =>
      api(`/app/api/evaluations/${evaluationId}/grading/run`, {
        method: "POST",
        body: JSON.stringify((itemIds ? { itemIds } : {}) satisfies GradingRunBody),
      }),
    onSuccess: () => {
      invalidate();
      toast(t("grading.run.started"), "progress");
    },
    onError: toastError("grading.run.failed"),
  });

  const links = gradingLinks(evaluationId);
  const openResults = () => navigate(links.results);
  useScreenCommands([
    {
      id: "grading:results",
      effect: "none",
      label: t("palette.openResults"),
      icon: BarChart3,
      group: "navigate",
      run: openResults,
    },
    {
      id: "grading:run",
      effect: "write",
      label: t("grading.run"),
      icon: CheckCheck,
      group: "action",
      run: () => run.mutate(undefined),
    },
    ...(onRegrade
      ? [
          {
            id: "grading:regrade",
            effect: "write" as const,
            label: t("grading.regrade"),
            icon: RefreshCcw,
            group: "action" as const,
            run: onRegrade,
          },
        ]
      : []),
  ]);

  return { validate, batch, validateBatch, run, openResults };
}
