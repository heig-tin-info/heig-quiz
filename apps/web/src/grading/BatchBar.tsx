import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import type { BatchValidateBody, BatchValidateResponse, GradingConfidence, GradingSource } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Button } from "../ui";

/** Above this many, a batch stops being a gesture and becomes a decision. */
export const BATCH_CONFIRM_THRESHOLD = 10;

export interface BatchScope {
  itemId?: string;
  source?: GradingSource;
  confidence?: GradingConfidence;
}

/**
 * The ONE accent action of the grading panel (F-GRADE-04): validate every
 * proposal of the current traversal in a single call.
 *
 * Above ten it goes through `useConfirm`, because forty grades moving at
 * once is not something to discover afterwards. The second button is a
 * ghost, never a second accent: the screen keeps one obvious thing to press.
 */
export function BatchBar({
  evaluationId,
  scope,
  count,
  scoped,
  primary,
}: {
  evaluationId: string;
  scope: BatchScope;
  /** Proposals matching `scope`. */
  count: number;
  /** The scope is narrower than "every proposal of this question". */
  scoped: boolean;
  /**
   * Whether this is the screen's accent action. It is not, while the
   * automatic pass has cells left to settle: "Run grading" is then the one
   * thing to press, and two red buttons on a page name neither of them.
   */
  primary: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();

  const validate = useMutation<BatchValidateResponse, unknown, BatchScope>({
    mutationFn: (body) =>
      api(`/app/api/evaluations/${evaluationId}/grading/validate-batch`, {
        method: "POST",
        body: JSON.stringify({ ...body, state: "proposed" } satisfies BatchValidateBody),
      }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["grading", evaluationId] });
      void qc.invalidateQueries({ queryKey: ["results", evaluationId] });
      toast(t("grading.batch.done", { n: result.validated }), "success");
    },
    onError: (error) => toast(apiErrorMessage(error, t("grading.batch.failed")), "error"),
  });

  const run = async (body: BatchScope, n: number) => {
    if (n > BATCH_CONFIRM_THRESHOLD) {
      const ok = await confirm({
        title: t("grading.batch.confirm.title", { n }),
        message: t("grading.batch.confirm.body", { n }),
        confirmLabel: t("grading.batch.confirm.ok"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) return;
    }
    validate.mutate(body);
  };

  if (count === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-card border border-line bg-surface px-5 py-4">
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Sparkles className="size-4.5" aria-hidden />
      </span>
      <div className="min-w-55 flex-1">
        <p className="text-[15px] font-semibold tracking-tight">
          {scoped
            ? t("grading.batch.titleFiltered", { n: count })
            : t("grading.batch.title", { n: count })}
        </p>
        <p className="mt-0.5 text-[13px] text-fg-muted">{t("grading.batch.body")}</p>
      </div>
      <Button
        size="lg"
        variant={primary ? "primary" : "secondary"}
        onClick={() => void run(scope, count)}
        loading={validate.isPending}
      >
        {t("grading.batch.action", { n: count })}
      </Button>
    </div>
  );
}
