/**
 * One student's drill, week by week (ADR-041 §8, #317 slice 4): how much
 * they practised, and how well they recall what they had practised before.
 *
 * Two small charts over the same weeks rather than one with two scales
 * (a count and a rate share no axis): the reviews through the shared
 * `Bars`, the recall rate as a line on 0–100 % with the scheduler's 90 %
 * target as a dashed rule — a rate near it means the schedule works, rising
 * towards it is progress. Neutral ink, one series each: the title names it.
 *
 * The line is an SVG stretched to its box with a non-scaling stroke; the
 * dots are divs placed in percent, so they stay round at every width. Each
 * week carries its numbers as a native tooltip, and each chart publishes
 * its figures as a visually hidden table.
 */
import type { DrillWeek } from "@quiz/contracts";
import { DRILL_TARGET_RETENTION, drillRecallRate } from "@quiz/domain";

import { useI18n, useT } from "../i18n";
import { Bars, percent } from "../ui";

/** "Oct 5", in the interface language; the date is a calendar date, read in UTC. */
export function weekLabel(weekStart: string, locale: "en" | "fr"): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${weekStart}T00:00:00Z`),
  );
}

/** A label every few weeks, so that a semester fits a phone. */
const tickEvery = (weeks: readonly DrillWeek[]) => Math.max(1, Math.ceil(weeks.length / 6));

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
  const every = tickEvery(weeks);
  return (
    <div>
      <div className="flex gap-2" aria-hidden>
        {/* 32 px and a gap of 8: the reviews' bars above are indented by the same 40 px (`pl-10`). */}
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
          <svg
            className="absolute inset-0 size-full overflow-visible text-fg-muted"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
          {weeks.map((w, i) => {
            const r = rates[i] ?? null;
            const date = weekLabel(w.weekStart, locale);
            return (
              <div
                key={w.weekStart}
                className="absolute inset-y-0"
                style={{ left: `${(i / n) * 100}%`, width: `${100 / n}%` }}
                title={
                  r === null
                    ? t("drill.chart.tip.none", { date })
                    : t("drill.chart.tip.recall", { date, rate: percent(r, locale), n: w.recall.repeated })
                }
              >
                {r === null ? null : (
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
      <div className="ml-10 mt-1.5 flex gap-0.5 border-t border-line pt-1.5 sm:gap-1" aria-hidden>
        {weeks.map((w, i) => (
          <span
            key={w.weekStart}
            className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[10px] tabular-nums text-fg-faint"
          >
            {i % every === 0 ? weekLabel(w.weekStart, locale) : ""}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{t("drill.chart.recall")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("drill.chart.week")}</th>
            <th scope="col">{t("drill.stat.recall")}</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => (
            <tr key={w.weekStart}>
              <th scope="row">{weekLabel(w.weekStart, locale)}</th>
              <td>{rates[i] == null ? "—" : percent(rates[i]!, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WeeklyProgress({ weeks }: { weeks: DrillWeek[] }) {
  const t = useT();
  const { locale } = useI18n();
  if (weeks.every((w) => w.reviews === 0)) {
    return <p className="py-6 text-center text-sm text-fg-muted">{t("drill.chart.empty")}</p>;
  }
  const every = tickEvery(weeks);
  return (
    <div className="space-y-8">
      <figure className="space-y-3">
        <figcaption className="text-sm font-semibold">{t("drill.chart.reviews")}</figcaption>
        <div className="pl-10">
          <Bars
            className="h-28"
            caption={t("drill.chart.reviews")}
            labelHeader={t("drill.chart.week")}
            valueHeader={t("drill.stat.reviews")}
            bars={weeks.map((w, i) => {
              const date = weekLabel(w.weekStart, locale);
              return {
                key: w.weekStart,
                value: w.reviews,
                label: date,
                tick: i % every === 0 ? date : "",
                title: t("drill.chart.tip.reviews", { date, n: w.reviews }),
              };
            })}
          />
        </div>
      </figure>
      <figure className="space-y-3">
        <figcaption className="text-sm font-semibold">{t("drill.chart.recall")}</figcaption>
        <RecallLine weeks={weeks} />
      </figure>
    </div>
  );
}
