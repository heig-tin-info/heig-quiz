import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RotateCcw } from "lucide-react";

import type { QuestionRow, QuestionStats, StatsReset } from "@quiz/contracts";
import {
  DISCRIMINATION_MIN_ITEMS,
  DISCRIMINATION_MIN_N,
  discriminationBand,
  DWELL_IDLE_CAP_MS,
  QUESTION_TIME_MIN_N,
  type DiscriminationBand,
} from "@quiz/domain";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { formatSpan, useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { poolQuestionStatsKey } from "../queryKeys";
import { Alert, Badge, Button, isoDateParts, SectionHeading, Sheet, Stat, type Tone } from "../ui";

/**
 * The item analysis of one question (ADR-038), opened from the chart icon of
 * its row or card on the pool screen: the success rate and the number of
 * answers it rests on, what was counted, and since when. Everything comes
 * from the pool's own list, which only holds the questions with enough
 * answers: the panel has no request of its own, and no empty state.
 *
 * The time spent (ADR-039) is a second block, with its own threshold: a
 * question may show its rate long before it has enough timed exam answers,
 * and then the block says so in one line rather than showing nothing.
 *
 * A reading panel: it has no primary action. The only button is the reset,
 * drawn for a contributor or an owner and absent for a reader (what is not
 * permitted is not drawn), destructive-styled and confirmed — the history it
 * sets aside cannot be brought back, even though nothing is deleted. Once it
 * is done the panel closes: the question has no statistics left to show,
 * and its icon leaves the list with the refresh.
 *
 * The rate is SIGNED, unlike the results screens (`displayedRate` clamps
 * it at 0 there): under negative marking a question may take away more than
 * it gives, and the author of the question is the one who needs to know.
 */
export function QuestionStatsSheet({
  poolId,
  row,
  stats,
  canReset,
  onClose,
}: {
  poolId: string;
  row: Pick<QuestionRow, "id" | "internalName">;
  stats: QuestionStats;
  canReset: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const confirm = useConfirm();

  const reset = useMutation({
    mutationFn: () =>
      api<StatsReset>(`/app/api/questions/${row.id}/stats/reset`, { method: "POST" }),
    onSuccess: async () => {
      toast(t("pool.stats.resetDone"), "success");
      onClose();
      await qc.invalidateQueries({ queryKey: poolQuestionStatsKey(poolId) });
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
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3">
          <Stat
            label={t("pool.stats.successRate")}
            value={`${Math.round(stats.p * 100)}%`}
            hint={stats.p < 0 ? t("pool.stats.negative") : undefined}
          />
          <Stat label={t("pool.stats.answers")} value={stats.n} />
        </div>
        <div className="space-y-2 text-sm text-fg-muted">
          <p>{t("pool.stats.scope")}</p>
          <p className="text-xs text-fg-faint">
            {stats.since
              ? t("pool.stats.since", { date: isoDateParts(stats.since).date })
              : t("pool.stats.sinceAlways")}
          </p>
        </div>
        <section className="space-y-3">
          <SectionHeading title={t("pool.stats.time")} />
          {stats.time ? (
            <>
              {/* On a phone the median takes the row, the two others share the next. */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="col-span-2 sm:col-span-1">
                  <Stat
                    label={t("pool.stats.timeMedian")}
                    value={formatSpan(stats.time.medianS, t)}
                    hint={t("pool.stats.timeRange", {
                      p25: formatSpan(stats.time.p25S, t),
                      p75: formatSpan(stats.time.p75S, t),
                    })}
                  />
                </div>
                <Stat label={t("pool.stats.timeMean")} value={formatSpan(stats.time.meanS, t)} />
                <Stat label={t("pool.stats.timeAnswers")} value={stats.time.n} />
              </div>
              <p className="text-sm text-fg-muted">
                {t("pool.stats.timeScope", { cap: DWELL_IDLE_CAP_MS / 60_000 })}
              </p>
            </>
          ) : (
            <p className="text-sm text-fg-muted">{t("pool.stats.timeNone", { min: QUESTION_TIME_MIN_N })}</p>
          )}
        </section>
        <DiscriminationBlock discrimination={stats.discrimination} />
      </div>
    </Sheet>
  );
}

/** How each reading of the index is drawn: an inverse question is the one to look at. */
const BAND_TONE: Record<DiscriminationBand, Tone> = {
  good: "green",
  fair: "zinc",
  weak: "amber",
  inverse: "red",
};

/**
 * The discrimination index (ADR-040), a third block: the value to two
 * decimals with its reading, what it rests on, and one sentence on what it
 * means. Like the time, it has its own conditions, so a question may show
 * its rate without it; the block then says when it will show.
 */
function DiscriminationBlock({ discrimination }: { discrimination: QuestionStats["discrimination"] }) {
  const t = useT();
  const band = discrimination && discriminationBand(discrimination.r);
  return (
    <section className="space-y-3">
      <SectionHeading title={t("pool.stats.discrimination")} />
      {discrimination && band ? (
        <>
          {/* Half the width, like the rate above it; the whole row on a phone. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat
              label={t("pool.stats.discriminationIndex")}
              value={
                <span className="flex items-center gap-2">
                  {discrimination.r.toFixed(2)}
                  <Badge tone={BAND_TONE[band]} icon={band === "inverse" ? AlertTriangle : undefined}>
                    {t(`pool.stats.discriminationBand.${band}`)}
                  </Badge>
                </span>
              }
              hint={
                discrimination.evaluations === 1
                  ? t("pool.stats.discriminationBasisOne", { n: discrimination.n })
                  : t("pool.stats.discriminationBasis", {
                      evaluations: discrimination.evaluations,
                      n: discrimination.n,
                    })
              }
            />
          </div>
          {band === "inverse" ? (
            <Alert tone="warning" icon={AlertTriangle}>
              {t("pool.stats.discriminationInverse")}
            </Alert>
          ) : null}
          <p className="text-sm text-fg-muted">{t("pool.stats.discriminationScope")}</p>
        </>
      ) : (
        <p className="text-sm text-fg-muted">
          {t("pool.stats.discriminationNone", { items: DISCRIMINATION_MIN_ITEMS, min: DISCRIMINATION_MIN_N })}
        </p>
      )}
    </section>
  );
}
