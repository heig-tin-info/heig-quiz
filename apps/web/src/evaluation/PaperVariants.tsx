/**
 * The paper's variants in the Export sheet (ADR-148): how many — a small
 * stepper, 1 to 26 — and Redraw, a quiet secondary action behind a
 * confirmation. Shown only where two papers can differ (`varies`): identical
 * papers under other letters would lie. Once a printed stack may be out (the
 * exam opened, a paper copy entered), Redraw and fewer variants are held, and
 * a muted line says why; one more stays possible.
 */
import { Lock, Minus, Plus, RefreshCw } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { PaperVariantsBody, type EvaluationDetail, type PaperVariantsState } from "@quiz/contracts";
import { MAX_PAPER_VARIANTS } from "@quiz/domain";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT, type Dict } from "../i18n";
import { useErrorToast } from "../notify";
import { evaluationKey } from "../queryKeys";
import { Button, IconButton } from "../ui";

/** Why the variants are held, as the sheet says it. */
const LOCKED = {
  opened: "eval.export.variants.locked.opened",
  paper_copy: "eval.export.variants.locked.paper_copy",
} as const satisfies Record<NonNullable<PaperVariantsState["locked"]>, keyof Dict>;

export function PaperVariants({ evaluationId, variants }: { evaluationId: string; variants: PaperVariantsState }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toastError = useErrorToast();
  const onSuccess = (next: EvaluationDetail) => qc.setQueryData(evaluationKey(evaluationId), next);
  const setCount = useMutation({
    mutationFn: (count: number) =>
      api<EvaluationDetail>(`/app/api/evaluations/${evaluationId}/paper-variants`, {
        method: "PUT",
        body: JSON.stringify(PaperVariantsBody.parse({ count })),
      }),
    onSuccess,
    onError: toastError("eval.export.variants.failed"),
  });
  const redraw = useMutation({
    mutationFn: () =>
      api<EvaluationDetail>(`/app/api/evaluations/${evaluationId}/paper-variants/redraw`, { method: "POST", body: "{}" }),
    onSuccess,
    onError: toastError("eval.export.variants.failed"),
  });
  const { count, locked } = variants;
  const busy = setCount.isPending || redraw.isPending;
  const lockedText = locked ? t(LOCKED[locked]) : null;

  const askRedraw = async () => {
    const ok = await confirm({
      title: t("eval.export.variants.redraw.title"),
      message: t("eval.export.variants.redraw.message"),
      confirmLabel: t("eval.export.variants.redraw"),
    });
    if (ok) redraw.mutate();
  };

  return (
    <section aria-labelledby="export-variants" className="space-y-2">
      <h3 id="export-variants" className="text-base font-semibold">
        {t("eval.export.variants")}
      </h3>
      <p className="text-sm text-fg-muted">{t("eval.export.variants.desc")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t("eval.export.variants.count")} className="flex items-center gap-1">
          <IconButton
            label={t("eval.export.variants.fewer")}
            size="sm"
            disabledReason={count === 1 ? null : lockedText}
            disabled={busy || count === 1}
            onClick={() => setCount.mutate(count - 1)}
          >
            <Minus />
          </IconButton>
          <output aria-live="polite" className="min-w-8 text-center text-base font-semibold tabular-nums">
            {count}
          </output>
          <IconButton
            label={t("eval.export.variants.more")}
            size="sm"
            disabled={busy || count === MAX_PAPER_VARIANTS}
            onClick={() => setCount.mutate(count + 1)}
          >
            <Plus />
          </IconButton>
        </div>
        <Button variant="ghost" size="sm" disabled={busy || locked !== null} onClick={() => void askRedraw()}>
          <RefreshCw /> {t("eval.export.variants.redraw")}
        </Button>
      </div>
      {lockedText ? (
        <p className="flex items-center gap-2 text-sm text-fg-faint">
          <Lock className="size-4 shrink-0" aria-hidden />
          {lockedText}
        </p>
      ) : null}
    </section>
  );
}
