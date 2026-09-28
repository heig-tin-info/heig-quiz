import { useMutation } from "@tanstack/react-query";
import { BarChart3, CheckCheck, RefreshCcw } from "lucide-react";

import type { GradingQueueItem } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import { useScreenCommands } from "../screenCommands";
import { gradingLinks } from "./index";
import { useGradingInvalidate } from "./useGradingInvalidate";

/**
 * What the grading panel does, as opposed to what it shows: validate one
 * proposal, run the grading pass, and the palette commands of the screen
 * (open the results, run the pass, re-grade the question at hand).
 *
 * `regradeTarget` is the question a palette "re-grade" means — the step's,
 * else the open answer's — and `onRegrade` opens its sheet.
 */
export function useGradingActions({
  evaluationId,
  navigate,
  regradeTarget,
  onRegrade,
}: {
  evaluationId: string;
  navigate: (r: Route) => void;
  regradeTarget: GradingQueueItem | undefined;
  onRegrade: (itemId: string) => void;
}) {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const invalidate = useGradingInvalidate(evaluationId);

  const validate = useMutation({
    mutationFn: (gradingId: string) =>
      api(`/app/api/gradings/${gradingId}/validate`, { method: "POST", body: "{}" }),
    onSuccess: invalidate,
    onError: toastError("grading.validate.failed"),
  });

  const run = useMutation({
    mutationFn: () =>
      api(`/app/api/evaluations/${evaluationId}/grading/run`, { method: "POST", body: "{}" }),
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
      label: t("palette.openResults"),
      icon: BarChart3,
      group: "navigate",
      run: openResults,
    },
    {
      id: "grading:run",
      label: t("grading.run"),
      icon: CheckCheck,
      group: "action",
      run: () => run.mutate(),
    },
    ...(regradeTarget
      ? [
          {
            id: "grading:regrade",
            label: t("grading.regrade"),
            icon: RefreshCcw,
            group: "action" as const,
            run: () => onRegrade(regradeTarget.id),
          },
        ]
      : []),
  ]);

  return { validate, run, openResults };
}
