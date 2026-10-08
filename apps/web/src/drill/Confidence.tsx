/**
 * What stated confidences add up to (ADR-085 §8, issue #453 part 2).
 *
 * - `DrillCalibration`, on the student's drill page: for each level they
 *   stated, how often they were right — their own reviews only, in plain
 *   words, a level with too few answers saying so instead of a rate.
 * - `ConfidencePerQuestion`, in the classroom's Drill tab: per question, the
 *   class's 2×2 (right or wrong × sure or unsure) and the share of confident
 *   errors among the wrong answers. The server sends only the questions
 *   stated by enough students; an individual statement never reaches it.
 *
 * Both are secondary sections of a read view: no accent, no action. The bar
 * is a share with no verdict (`info`, as the mastery per tag), and its figure
 * is always written beside it, so colour is never the only reading.
 */
import type { DrillCalibrationLevel, DrillConfidenceSplit, DrillQuestionConfidence } from "@quiz/contracts";
import {
  DRILL_CALIBRATION_MIN_N,
  DRILL_CONFIDENCE_MIN_STUDENTS,
  drillCalibrationRate,
  drillConfidentErrorShare,
} from "@quiz/domain";
import { Eye, Gauge } from "lucide-react";

import { useI18n, useT } from "../i18n";
import { Card, cx, EmptyState, percent, QueryError, SectionHeading, SegmentedBar, Skeleton } from "../ui";
import { useClassroomDrillConfidence, useDrillCalibration } from "./api";
import { CONFIDENCE } from "./format";

// --- Student -----------------------------------------------------------------

/** The student's calibration; nothing at all until they have stated a confidence once. */
export function DrillCalibration() {
  const t = useT();
  const calibration = useDrillCalibration();
  if (calibration.isLoading) return <Skeleton className="h-48 w-full" />;
  // A secondary read: failed, it leaves the page as it was rather than put
  // an error card under the day's one action. Never stated: the card's
  // "How sure are you?" is where it starts.
  if (!calibration.data || calibration.data.every((l) => l.answers === 0)) return null;
  return (
    <section className="space-y-3">
      <SectionHeading icon={Gauge} title={t("drill.calibration.title")} description={t("drill.calibration.desc")} />
      <Card className="divide-y divide-line">
        {calibration.data.map((level) => (
          <CalibrationRow key={level.confidence} level={level} />
        ))}
      </Card>
      <p className="px-1 text-xs text-fg-faint">{t("drill.calibration.help", { n: DRILL_CALIBRATION_MIN_N })}</p>
    </section>
  );
}

function CalibrationRow({ level }: { level: DrillCalibrationLevel }) {
  const t = useT();
  const { locale } = useI18n();
  const rate = drillCalibrationRate(level);
  const name = t(CONFIDENCE[level.confidence]!);
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <p className={cx("min-w-0 text-sm", rate === null && "text-fg-muted")}>
          {rate === null
            ? t("drill.calibration.notEnough", { level: name })
            : t("drill.calibration.right", { level: name, rate: percent(rate, locale) })}
        </p>
        <p className="shrink-0 text-xs tabular-nums text-fg-faint">
          {t(level.answers === 1 ? "drill.calibration.answers.one" : "drill.calibration.answers", { n: level.answers })}
        </p>
      </div>
      {rate === null ? null : <SegmentedBar parts={[{ tone: "info", value: rate }]} total={1} />}
    </div>
  );
}

// --- Teacher -----------------------------------------------------------------

/** Per question of the classroom, the 2×2 of confidence; an empty state while no question has enough students. */
export function ConfidencePerQuestion({ classroomId }: { classroomId: string }) {
  const t = useT();
  const confidence = useClassroomDrillConfidence(classroomId);
  let body;
  if (confidence.isLoading) {
    body = <Skeleton className="h-40 w-full" />;
  } else if (confidence.isError || !confidence.data) {
    body = (
      <QueryError
        title={t("drill.confidenceSplit.loadFailed")}
        error={confidence.error}
        onRetry={() => void confidence.refetch()}
        retrying={confidence.isFetching}
        fallback={t("error.server")}
      />
    );
  } else if (confidence.data.length === 0) {
    body = (
      <Card>
        <EmptyState icon={Gauge} title={t("drill.confidenceSplit.none.title")}>
          {t("drill.confidenceSplit.none.body", { n: DRILL_CONFIDENCE_MIN_STUDENTS })}
        </EmptyState>
      </Card>
    );
  } else {
    body = (
      <>
        <Card className="divide-y divide-line">
          {confidence.data.map((q) => (
            <QuestionConfidenceRow key={q.questionId} row={q} />
          ))}
        </Card>
        <p className="px-1 text-xs text-fg-faint">
          {t("drill.confidenceSplit.help", { n: DRILL_CONFIDENCE_MIN_STUDENTS })}
        </p>
      </>
    );
  }
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Gauge}
        title={t("drill.confidenceSplit.title")}
        description={t("drill.confidenceSplit.desc")}
      />
      {body}
    </section>
  );
}

const total = (s: DrillConfidenceSplit) => s.rightSure + s.rightUnsure + s.wrongSure + s.wrongUnsure;

function QuestionConfidenceRow({ row }: { row: DrillQuestionConfidence }) {
  const t = useT();
  const { locale } = useI18n();
  const { split } = row;
  const share = drillConfidentErrorShare(split);
  const wrong = split.wrongSure + split.wrongUnsure;
  return (
    <div className="grid items-center gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{row.name}</p>
        <p className="text-xs text-fg-faint">
          {t("drill.confidenceSplit.counts", { n: total(split), students: row.students })}
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          {share === null
            ? t("drill.confidenceSplit.noWrong")
            : t("drill.confidenceSplit.share", { rate: percent(share, locale), n: split.wrongSure, wrong })}
        </p>
      </div>
      <SplitTable split={split} />
    </div>
  );
}

/** The 2×2 as a table: a screen reader reads its headers; the confident errors' cell is marked by an icon and weight, its tint only added. */
function SplitTable({ split }: { split: DrillConfidenceSplit }) {
  const t = useT();
  const { locale } = useI18n();
  const all = total(split);
  const cell = (n: number, marked = false) => {
    // The confident errors' cell is marked only when it holds some.
    const confidentError = marked && n > 0;
    return (
    <td
      className={cx(
        "w-20 rounded-md px-3 py-1.5 text-right tabular-nums",
        confidentError ? "bg-warning-soft font-semibold" : "bg-surface-2",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        {confidentError ? <Eye className="size-3.5 text-warning" aria-hidden /> : null}
        {n}
      </span>
      <span className="block text-[11px] font-normal text-fg-faint">{all > 0 ? percent(n / all, locale) : "—"}</span>
    </td>
    );
  };
  return (
    <table className="border-separate border-spacing-1 text-[13px]">
      <caption className="sr-only">{t("drill.confidenceSplit.caption")}</caption>
      <thead>
        <tr className="text-xs text-fg-muted">
          <td />
          <th scope="col" className="px-3 font-medium">
            {t("drill.confidenceSplit.sure")}
          </th>
          <th scope="col" className="px-3 font-medium">
            {t("drill.confidenceSplit.unsure")}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row" className="pr-2 text-left text-xs font-medium text-fg-muted">
            {t("drill.confidenceSplit.right")}
          </th>
          {cell(split.rightSure)}
          {cell(split.rightUnsure)}
        </tr>
        <tr>
          <th scope="row" className="pr-2 text-left text-xs font-medium text-fg-muted">
            {t("drill.confidenceSplit.wrong")}
          </th>
          {cell(split.wrongSure, true)}
          {cell(split.wrongUnsure)}
        </tr>
      </tbody>
    </table>
  );
}
