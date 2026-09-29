import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, RotateCcw } from "lucide-react";

import type { ItemStats, QuestionRow, QuestionStats, StatsReset } from "@quiz/contracts";
import { QUESTION_STATS_MIN_N } from "@quiz/domain";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { poolQuestionStatsKey, questionStatsKey } from "../queryKeys";
import { Button, EmptyState, isoDateParts, QueryError, Sheet, Skeleton, Stat } from "../ui";

/**
 * The item analysis of one question (ADR-038), opened from the chart icon of
 * its row or card on the pool screen: the success rate and the number of
 * answers it rests on, what was counted, and since when.
 *
 * A reading panel: it has no primary action. The only button is the reset,
 * drawn for a contributor or an owner and absent for a reader (what is not
 * permitted is not drawn), destructive-styled and confirmed — the history it
 * sets aside cannot be brought back, even though nothing is deleted.
 *
 * The rate is SIGNED, unlike the results screens (`displayedRate` clamps
 * it at 0 there): under negative marking a question may take away more than
 * it gives, and the author of the question is the one who needs to know.
 *
 * The pool's own list already carries the numbers of every question that
 * has them, so the panel opens on them at once (`initialData`) and the
 * question's route adds the one thing the list lacks: the last reset.
 */
export function QuestionStatsSheet({
  poolId,
  row,
  seed,
  canReset,
  onClose,
}: {
  poolId: string;
  row: Pick<QuestionRow, "id" | "internalName">;
  /** The pool list's entry for this question, when it has one. */
  seed?: ItemStats | undefined;
  canReset: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();

  const stats = useQuery<QuestionStats>({
    queryKey: questionStatsKey(row.id),
    queryFn: () => api(`/app/api/questions/${row.id}/stats`),
  });

  const reset = useMutation({
    mutationFn: () =>
      api<StatsReset>(`/app/api/questions/${row.id}/stats/reset`, { method: "POST" }),
    onSuccess: async () => {
      toast(t("pool.stats.resetDone"), "success");
      await Promise.all([
        qc.invalidateQueries({ queryKey: questionStatsKey(row.id) }),
        qc.invalidateQueries({ queryKey: poolQuestionStatsKey(poolId) }),
      ]);
    },
    onError: toastError("pool.stats.resetFailed"),
  });

  const askReset = async () => {
    const ok = await confirm({
      title: t("pool.stats.resetTitle", { name: row.internalName }),
      message: t("pool.stats.resetBody"),
      confirmLabel: t("pool.stats.resetConfirm"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (ok) reset.mutate();
  };

  // The list's numbers while the question's own answer is on its way.
  const shown = stats.data ? stats.data.stats : (seed ?? null);

  return (
    <Sheet
      title={t("pool.stats.title")}
      subtitle={<span className="font-mono">{row.internalName}</span>}
      onClose={onClose}
      footer={
        canReset ? (
          <Button variant="danger" loading={reset.isPending} onClick={() => void askReset()}>
            <RotateCcw /> {t("pool.stats.reset")}
          </Button>
        ) : undefined
      }
    >
      {stats.isError ? (
        <QueryError
          title={t("pool.stats.title")}
          error={stats.error}
          onRetry={() => void stats.refetch()}
          retrying={stats.isFetching}
        />
      ) : stats.isLoading && !shown ? (
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <div className="space-y-6">
          {shown ? (
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label={t("pool.stats.successRate")}
                value={`${Math.round(shown.p * 100)}%`}
                hint={shown.p < 0 ? t("pool.stats.negative") : undefined}
              />
              <Stat label={t("pool.stats.answers")} value={shown.n} />
            </div>
          ) : (
            <EmptyState
              icon={BarChart3}
              title={t("pool.stats.notEnough", { min: QUESTION_STATS_MIN_N })}
              className="py-8"
            />
          )}
          <div className="space-y-2 text-sm text-fg-muted">
            <p>{t("pool.stats.scope")}</p>
            {stats.data ? (
              <p className="text-xs text-fg-faint">
                {stats.data.since
                  ? t("pool.stats.since", { date: isoDateParts(stats.data.since).date })
                  : t("pool.stats.sinceAlways")}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </Sheet>
  );
}
