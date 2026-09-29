/**
 * One student's drill, week by week (ADR-041 §8, #317 slice 4): how much
 * they practised, and how well they recall what they had practised before.
 *
 * Two small charts over the same weeks rather than one with two scales
 * (a count and a rate share no axis): the reviews as bars, the recall rate
 * as a line on 0–100 % with the scheduler's 90 % target as a dashed rule —
 * a rate near it means the schedule works, rising towards it is progress.
 * Neutral ink, one series each: the title names it, no legend is needed.
 *
 * Plain elements on the tokens, like the results' histogram: bars are divs
 * whose height is a percentage, the line an SVG stretched to the box with a
 * non-scaling stroke, the dots divs placed in percent so they stay round at
 * every width. Each week carries its numbers as a native tooltip, and the
 * same numbers are published as a visually hidden table.
 */
import type { DrillWeek } from "@quiz/contracts";
import { DRILL_TARGET_RETENTION, drillRecallRate } from "@quiz/domain";

import { useI18n, useT } from "../i18n";
import { cx } from "../ui";

/** "5 Oct", in the interface language; the date is a calendar date, read in UTC. */
export function weekLabel(weekStart: string, locale: "en" | "fr"): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${weekStart}T00:00:00Z`),
  );
}

export function percent(rate: number, locale: "en" | "fr"): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(rate);
}

/** The x axis: a label every few weeks, so that a semester fits a phone. */
function WeekAxis({ weeks }: { weeks: DrillWeek[] }) {
  const { locale } = useI18n();
  const every = Math.max(1, Math.ceil(weeks.length / 6));
  return (
    <div className="mt-1.5 flex border-t border-line pt-1.5" aria-hidden>
      {weeks.map((w, i) => (
        <span key={w.weekStart} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-[10px] tabular-nums text-fg-faint">
          {i % every === 0 ? weekLabel(w.weekStart, locale) : ""}
        </span>
      ))}
    </div>
  );
}

function ReviewBars({ weeks }: { weeks: DrillWeek[] }) {
  const t = useT();
  const { locale } = useI18n();
  const top = Math.max(1, ...weeks.map((w) => w.reviews));
  return (
    <div className="flex h-28 items-end gap-0.5 sm:gap-1" aria-hidden>
      {weeks.map((w) => (
        <div
          key={w.weekStart}
          title={t("drill.chart.tip.reviews", { date: weekLabel(w.weekStart, locale), n: w.reviews })}
          className="flex h-full min-w-0 flex-1 flex-col justify-end"
        >
          <span
            className={cx("w-full rounded-t-[4px]", w.reviews === 0 ? "bg-surface-3" : "bg-fg-muted")}
            style={{ height: `${Math.max(w.reviews === 0 ? 2 : 6, (w.reviews / top) * 100)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function RecallLine({ weeks }: { weeks: DrillWeek[] }) {
  const t = useT();
  const { locale } = useI18n();
  const n = weeks.length;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const y = (rate: number) => (1 - rate) * 100;
  const rates = weeks.map((w) => drillRecallRate(w.recall));
  // The line breaks over a week without repeated reviews: no rate is not 0 %.
  const path = rates
    .map((r, i) => (r === null ? null : `${rates[i - 1] == null ? "M" : "L"}${x(i)},${y(r)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex gap-2" aria-hidden>
      <div className="relative h-28 w-8 shrink-0 text-right text-[10px] tabular-nums text-fg-faint">
        <span className="absolute right-0 top-0 -translate-y-1/2">{percent(1, locale)}</span>
        <span className="absolute right-0 top-1/2 -translate-y-1/2">{percent(0.5, locale)}</span>
        <span className="absolute bottom-0 right-0 translate-y-1/2">{percent(0, locale)}</span>
      </div>
      <div className="relative h-28 min-w-0 flex-1">
        <div className="absolute inset-x-0 top-0 border-t border-line" />
        <div className="absolute inset-x-0 top-1/2 border-t border-line" />
        <div className="absolute inset-x-0 bottom-0 border-t border-line" />
        <div
          className="absolute inset-x-0 border-t border-dashed border-fg-faint"
          style={{ top: `${y(DRILL_TARGET_RETENTION)}%` }}
        >
          <span className="absolute left-1 -translate-y-full bg-surface px-1 pb-0.5 text-[10px] text-fg-faint">
            {t("drill.chart.target")}
          </span>
        </div>
        <svg className="absolute inset-0 size-full overflow-visible text-fg-muted" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
        {weeks.map((w, i) => {
          const r = rates[i];
          const date = weekLabel(w.weekStart, locale);
          return (
            <div
              key={w.weekStart}
              className="absolute inset-y-0"
              style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%` }}
              title={
                r === null || r === undefined
                  ? t("drill.chart.tip.none", { date })
                  : t("drill.chart.tip.recall", { date, rate: percent(r, locale), n: w.recall.repeated })
              }
            >
              {r === null || r === undefined ? null : (
                <span
                  className="absolute left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg ring-2 ring-surface"
                  style={{ top: `${y(r)}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function WeeklyProgress({ weeks }: { weeks: DrillWeek[] }) {
  const t = useT();
  const { locale } = useI18n();
  if (weeks.every((w) => w.reviews === 0)) {
    return <p className="py-6 text-center text-sm text-fg-muted">{t("drill.chart.empty")}</p>;
  }
  return (
    <div className="space-y-8">
      <figure className="space-y-3">
        <figcaption className="text-sm font-semibold">{t("drill.chart.reviews")}</figcaption>
        <div className="pl-10">
          <ReviewBars weeks={weeks} />
          <WeekAxis weeks={weeks} />
        </div>
      </figure>
      <figure className="space-y-3">
        <figcaption className="text-sm font-semibold">{t("drill.chart.recall")}</figcaption>
        <div>
          <RecallLine weeks={weeks} />
          <div className="pl-10">
            <WeekAxis weeks={weeks} />
          </div>
        </div>
      </figure>
      <table className="sr-only">
        <caption>{t("drill.chart.reviews")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("drill.chart.week")}</th>
            <th scope="col">{t("drill.stat.reviews")}</th>
            <th scope="col">{t("drill.stat.recall")}</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => {
            const r = drillRecallRate(w.recall);
            return (
              <tr key={w.weekStart}>
                <th scope="row">{weekLabel(w.weekStart, locale)}</th>
                <td>{w.reviews}</td>
                <td>{r === null ? "—" : percent(r, locale)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
