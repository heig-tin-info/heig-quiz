import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { EvaluationDetail, ItemCounting, ItemCountingBody, ItemCountingResult } from "@quiz/contracts";
import { evaluationTotal, formatPoints, itemListLock, lacksGradedPoints } from "@quiz/domain";

import { api, wordedRefusal } from "../api";
import { useConfirm } from "../confirm";
import { useT, type Dict } from "../i18n";
import { useToast } from "../notify";
import { evaluationKey } from "../queryKeys";
import { useGradingInvalidate } from "./useGradingInvalidate";

/** The three states, in the order the menu offers them. */
export const COUNTINGS: readonly ItemCounting[] = ["normal", "bonus", "neutralized"];

/** What each state does to the points, said in the confirmation. */
const EFFECT: Record<ItemCounting, keyof Dict> = {
  normal: "grading.counting.effect.normal",
  bonus: "grading.counting.effect.bonus",
  neutralized: "grading.counting.effect.neutralized",
};

/** The evaluation's total if `itemId` counted as `counting`: the server's one rule. */
export function totalIf(detail: EvaluationDetail, itemId: string, counting: ItemCounting): number {
  return evaluationTotal(detail.items.map((i) => (i.id === itemId ? { ...i, counting } : i)));
}

/**
 * The grading-time counting act (ADR-108): an item counts normally, as a
 * bonus, or not at all, once the evaluation has run. `offered` is the
 * server's gate read off the page — a frozen item list, never a poll — and
 * `refused(itemId, counting)` names a choice that would leave nothing in the
 * total, which the menu greys out rather than letting the server refuse it.
 * `change` asks first, saying the new total and, once released, that the
 * students whose grade changes are told; then the grading reads and the
 * evaluation are read again.
 */
export function useItemCounting(evaluationId: string, detail: EvaluationDetail | undefined) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const invalidate = useGradingInvalidate(evaluationId);

  const mutation = useMutation<ItemCountingResult, unknown, { itemId: string; counting: ItemCounting }>({
    mutationFn: ({ itemId, counting }) =>
      api(`/app/api/evaluations/${evaluationId}/items/${itemId}/counting`, {
        method: "PUT",
        body: JSON.stringify({ counting } satisfies ItemCountingBody),
      }),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: evaluationKey(evaluationId) });
      toast(t("grading.counting.done"), "success");
    },
    onError: (error) =>
      toast(wordedRefusal(error, { illegal_transition: "grading.counting.noGradedPoints" }, t), "error"),
  });

  const offered =
    detail !== undefined &&
    detail.evaluation.mode !== "poll" &&
    itemListLock(detail.evaluation.state, detail.attemptCount) !== null;

  const refused = (itemId: string, counting: ItemCounting) =>
    detail !== undefined && lacksGradedPoints(detail.evaluation.mode, totalIf(detail, itemId, counting));

  const change = async (item: { id: string; position: number; counting: ItemCounting }, counting: ItemCounting) => {
    if (!detail || item.counting === counting) return;
    const ok = await confirm({
      title: t("grading.counting.confirm.title", { n: item.position + 1 }),
      message: (
        <div className="space-y-2">
          <p>{t(EFFECT[counting])}</p>
          <p className="font-semibold tabular-nums text-fg">
            {t("grading.counting.confirm.total", {
              from: formatPoints(detail.totalPoints),
              to: formatPoints(totalIf(detail, item.id, counting)),
            })}
          </p>
          {detail.evaluation.releasedAt !== null ? (
            <p>{t("grading.counting.confirm.released")}</p>
          ) : null}
        </div>
      ),
      confirmLabel: t("grading.counting.confirm.ok"),
    });
    if (ok) mutation.mutate({ itemId: item.id, counting });
  };

  return { offered, refused, change };
}
