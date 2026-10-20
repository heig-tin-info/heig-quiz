import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RotateCcw } from "lucide-react";

import {
  hasExamStats,
  type DiscriminationStats,
  type DistractorStats,
  type QuestionRow,
  type QuestionStats,
  type StatsReset,
  type RevisionTimeStats,
} from "@quiz/contracts";
import {
  DISCRIMINATION_FAIR,
  DISCRIMINATION_GOOD,
  DISCRIMINATION_MIN_ITEMS,
  DISCRIMINATION_MIN_N,
  discriminationBand,
  DWELL_IDLE_CAP_MS,
  QUESTION_STATS_MIN_N,
  QUESTION_TIME_MIN_N,
  REVISION_TIME_MIN_STUDENTS,
  type DiscriminationBand,
} from "@quiz/domain";
import { choiceLetter } from "@quiz/qt-mcq/client";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { formatDecimal, formatSpan, useI18n, useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { useErrorToast, useToast } from "../notify";
import { poolQuestionStatsKey } from "../queryKeys";
import { Alert, Badge, Button, isoDateParts, SectionHeading, SegmentedBar, Sheet, Stat, type Tone } from "../ui";
import { ratePercent } from "./filters";

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
 * The time in targeted revision (ADR-039 §6b) is a separate series, drawn
 * last. A question may be in the list for it alone: its exam figures are
 * then null, and the top block says there are no exam statistics yet
 * instead of drawing the exam's blocks.
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
      danger: true,
    });
    if (ok) reset.mutate();
  };

  // The exam's figures, all or none: an entry listed for its time in revision alone has none.
  const exam = hasExamStats(stats) ? stats : null;
  const since = (
    <p className="text-xs text-fg-faint">
      {stats.since ? t("pool.stats.since", { date: isoDateParts(stats.since).date }) : t("pool.stats.sinceAlways")}
    </p>
  );

  return (
    <Sheet
      title={t("pool.stats.title")}
      subtitle={row.internalName}
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
        {exam ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Stat
                label={t("pool.stats.successRate")}
                value={`${ratePercent(exam.p)}%`}
                hint={exam.p < 0 ? t("pool.stats.negative") : undefined}
              />
              <Stat label={t("pool.stats.answers")} value={exam.n} />
            </div>
            <div className="space-y-2 text-sm text-fg-muted">
              <p>{t("pool.stats.scope")}</p>
              {since}
            </div>
            <TimeBlock
              title={t("pool.stats.time")}
              time={exam.time}
              count={t("pool.stats.timeAnswers")}
              scope={t("pool.stats.timeScope", { cap: DWELL_IDLE_CAP_MS / 60_000 })}
              none={t("pool.stats.timeNone", { min: QUESTION_TIME_MIN_N })}
            />
            <DiscriminationBlock discrimination={exam.discrimination} />
            {exam.distractors === undefined ? null : <DistractorBlock distractors={exam.distractors} />}
          </>
        ) : (
          <div className="space-y-2 text-sm text-fg-muted">
            <p>{t("pool.stats.examNone", { min: QUESTION_STATS_MIN_N })}</p>
            {since}
          </div>
        )}
        {/* A separate series (ADR-039 §6b), last and apart from the exam's blocks: its `n` counts students. */}
        <TimeBlock
          title={t("pool.stats.revisionTime")}
          time={stats.revisionTime}
          count={t("pool.stats.revisionStudents")}
          scope={t("pool.stats.revisionScope")}
          none={t("pool.stats.revisionNone", { min: REVISION_TIME_MIN_STUDENTS })}
        />
      </div>
    </Sheet>
  );
}

/**
 * A time series' block: the median with its middle half, the mean when the
 * series carries one (the revision series does not, ADR-039 §6b), what `n`
 * counts and one line on what the series is; below its threshold, one line
 * saying when it will show.
 */
function TimeBlock({
  title,
  time,
  count,
  scope,
  none,
}: {
  title: string;
  time: (RevisionTimeStats & { meanS?: number }) | null;
  count: string;
  scope: string;
  none: string;
}) {
  const t = useT();
  const mean = time?.meanS;
  return (
    <section className="space-y-3">
      <SectionHeading title={title} />
      {time ? (
        <>
          {/* With a mean, on a phone the median takes the row and the two others share the next. */}
          <div className={mean === undefined ? "grid grid-cols-2 gap-3" : "grid grid-cols-2 gap-3 sm:grid-cols-3"}>
            <div className={mean === undefined ? undefined : "col-span-2 sm:col-span-1"}>
              <Stat
                label={t("pool.stats.timeMedian")}
                value={formatSpan(time.medianS, t)}
                hint={t("pool.stats.timeRange", { p25: formatSpan(time.p25S, t), p75: formatSpan(time.p75S, t) })}
              />
            </div>
            {mean === undefined ? null : <Stat label={t("pool.stats.timeMean")} value={formatSpan(mean, t)} />}
            <Stat label={count} value={time.n} />
          </div>
          <p className="text-sm text-fg-muted">{scope}</p>
        </>
      ) : (
        <p className="text-sm text-fg-muted">{none}</p>
      )}
    </section>
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
 * The discrimination index (ADR-042), a third block: the value to two
 * decimals with its reading, what it rests on, and one sentence on what it
 * means. Like the time, it has its own conditions, so a question may show
 * its rate without it; the block then says when it will show.
 */
function DiscriminationBlock({ discrimination }: { discrimination: DiscriminationStats | null }) {
  const t = useT();
  return (
    <section className="space-y-3">
      <SectionHeading title={t("pool.stats.discrimination")} />
      {discrimination ? (
        <DiscriminationValue discrimination={discrimination} />
      ) : (
        <p className="text-sm text-fg-muted">
          {t("pool.stats.discriminationNone", { items: DISCRIMINATION_MIN_ITEMS, min: DISCRIMINATION_MIN_N })}
        </p>
      )}
    </section>
  );
}

function DiscriminationValue({ discrimination }: { discrimination: DiscriminationStats }) {
  const { t, locale } = useI18n();
  const band = discriminationBand(discrimination.r);
  return (
    <>
      {/* Half the width, like the rate above it; the whole row on a phone. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat
          label={t("pool.stats.discriminationIndex")}
          value={
            <span className="flex items-center gap-2">
              {formatDecimal(discrimination.r, 2, locale)}
              <Badge tone={BAND_TONE[band]}>{t(`pool.stats.discriminationBand.${band}`)}</Badge>
            </span>
          }
          hint={
            discrimination.evaluations === 1
              ? t("pool.stats.discriminationBasisOne", { n: discrimination.n })
              : t("pool.stats.discriminationBasis", { evaluations: discrimination.evaluations, n: discrimination.n })
          }
        />
      </div>
      {band === "inverse" ? (
        <Alert tone="warning" icon={AlertTriangle}>
          {t("pool.stats.discriminationInverse")}
        </Alert>
      ) : null}
      <p className="text-sm text-fg-muted">
        {t("pool.stats.discriminationScope", {
          fair: formatDecimal(DISCRIMINATION_FAIR, 1, locale),
          good: formatDecimal(DISCRIMINATION_GOOD, 1, locale),
        })}
      </p>
    </>
  );
}

/**
 * The distractor analysis of a multiple-choice question (ADR-043), a fourth
 * block, drawn only for a type that has it: one row per option in the
 * question's order — its letter, its text, its share and a bar — then the
 * answers that picked nothing, drawn like the class debrief's distribution
 * (results/ByQuestionView). The key says so in words, the debrief's green
 * badge. The bar is `info`, never a verdict colour: a share is a datum. Only
 * shares, never counts: the server sends nothing else (N-DATA-06).
 *
 * It rests on its own `n` — the answers to the versions that carry the
 * current options —, which the basis line says.
 */
function DistractorBlock({ distractors }: { distractors: DistractorStats | null }) {
  const t = useT();
  return (
    <section className="space-y-3">
      <SectionHeading title={t("pool.stats.choices")} />
      {distractors ? (
        <DistractorRows distractors={distractors} />
      ) : (
        <p className="text-sm text-fg-muted">{t("pool.stats.choicesNone", { min: QUESTION_STATS_MIN_N })}</p>
      )}
    </section>
  );
}

function DistractorRows({ distractors }: { distractors: DistractorStats }) {
  const t = useT();
  const rows = [
    ...distractors.options.map((option, index) => ({ ...option, letter: choiceLetter(index) })),
    { text: null, correct: false, share: distractors.none, letter: null },
  ];
  return (
    <>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.letter ?? "none"} className="flex flex-col gap-1.5 text-sm">
            <div className="flex items-start gap-2">
              {row.letter === null ? null : (
                <span className="w-4 shrink-0 font-semibold text-fg-muted">{row.letter}</span>
              )}
              {row.text === null ? (
                <span className="min-w-0 flex-1 text-fg-muted">{t("pool.stats.choicesNoAnswer")}</span>
              ) : (
                <MarkdownView as="span" source={row.text} inline className="min-w-0 flex-1" />
              )}
              {row.correct ? <Badge tone="green">{t("results.byQuestion.correct")}</Badge> : null}
              <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums">
                {t("poll.percent", { n: row.share })}
              </span>
            </div>
            <SegmentedBar parts={[{ tone: row.letter === null ? "muted" : "info", value: row.share }]} total={100} />
            {/* A value drawn for each student: its share is its place's (ADR-056 §9). */}
            {"drawn" in row && row.drawn ? (
              <p className="text-xs text-fg-muted">{t("pool.stats.choicesDrawn")}</p>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-faint">
        {t("pool.stats.choicesBasis", { n: distractors.n })}
        {distractors.multiple ? ` ${t("pool.stats.choicesMultiple")}` : null}
      </p>
    </>
  );
}
