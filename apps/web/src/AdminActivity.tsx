import { useQuery } from "@tanstack/react-query";
import { ChartColumn } from "lucide-react";
import { useState } from "react";

import type { ActivityCount, AdminActivity } from "@quiz/contracts";
import { CLASS_HOURS, isClassHour, SCHOOL_TIME_ZONE, type Locale } from "@quiz/domain";

import { api } from "./api";
import { useI18n, useT } from "./i18n";
import { adminActivityKey } from "./queryKeys";
import { Card, cx, EmptyState, QueryError, SectionHeading, Segmented, Skeleton, Stat } from "./ui";

/** Whose activity the grid shows. */
export type ActivityWho = "all" | "students" | "staff";

const valueOf = (cell: ActivityCount, who: ActivityWho): number =>
  who === "all" ? cell.students + cell.staff : cell[who];

/** The five steps of the ramp (`--heat-1..5`, DESIGN.md "The activity heatmap"), and their ink. */
const STEPS = [
  "bg-heat-1 text-fg",
  "bg-heat-2 text-fg",
  "bg-heat-3 text-fg",
  "bg-heat-4 text-heat-ink-4",
  "bg-heat-5 text-on-fill",
] as const;

/** The step of `value` on a scale that ends at `top`: 0 for nothing, else 1–5. */
export function heatStep(value: number, top: number): number {
  if (value <= 0 || top <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil((value / top) * 5)));
}

/** Outside class hours: a hatch over whatever the cell holds, faint enough to keep its figure legible. */
const OFF_HOURS = "bg-[image:repeating-linear-gradient(135deg,color-mix(in_srgb,var(--fg)_11%,transparent)_0_1.5px,transparent_1.5px_6px)]";

const dayLabel = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );

const pad = (h: number) => String(h).padStart(2, "0");

/**
 * The platform's activity (F-ADMIN-09, ADR-107): who used it, and when, over
 * the last seven days. Observation only — the screen has no action; its one
 * control picks whose activity the grid shows. Aggregates only: no person is
 * named anywhere on it.
 */
export function ActivitySection() {
  const t = useT();
  const { locale } = useI18n();
  const [who, setWho] = useState<ActivityWho>("all");
  const activity = useQuery<AdminActivity>({
    queryKey: adminActivityKey,
    queryFn: () => api("/app/api/admin/activity"),
  });

  const heading = (
    <SectionHeading icon={ChartColumn} title={t("admin.activity.title")} description={t("admin.activity.hint")} />
  );

  if (activity.isLoading) {
    return (
      <section className="space-y-3" aria-busy="true">
        {heading}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[78px] w-full" />
          ))}
        </div>
        <Skeleton className="h-80 w-full" />
      </section>
    );
  }
  if (activity.isError || !activity.data) {
    return (
      <section className="space-y-3">
        {heading}
        <QueryError title={t("admin.activity.title")} query={activity} />
      </section>
    );
  }

  const data = activity.data;
  const total = (c: ActivityCount) => c.students + c.staff;
  const split = (c: ActivityCount) => t("admin.activity.split", { students: c.students, staff: c.staff });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const classHours = t("admin.activity.window", {
    start: pad(CLASS_HOURS.weekdayStart),
    end: pad(CLASS_HOURS.weekdayEnd),
    zone: SCHOOL_TIME_ZONE,
  });

  return (
    <section className="space-y-3">
      {heading}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t("admin.activity.now")} value={total(data.activeNow)} hint={split(data.activeNow)} />
        <Stat label={t("admin.activity.day")} value={total(data.last24h)} hint={split(data.last24h)} />
        <Stat label={t("admin.activity.week")} value={total(data.last7d)} hint={split(data.last7d)} />
        <Stat
          label={t("admin.activity.offHours")}
          value={data.offHoursStudentShare === null ? "—" : percent.format(data.offHoursStudentShare)}
          hint={t("admin.activity.offHours.hint", { window: classHours })}
        />
      </div>
      {total(data.last7d) === 0 ? (
        <Card>
          <EmptyState icon={ChartColumn} title={t("admin.activity.empty.title")}>
            {t("admin.activity.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-fg">{t("admin.activity.grid.title")}</h3>
            <Segmented<ActivityWho>
              name="admin-activity-who"
              label={t("admin.activity.who")}
              value={who}
              onChange={setWho}
              options={[
                { value: "all", label: t("admin.activity.who.all") },
                { value: "students", label: t("admin.activity.who.students") },
                { value: "staff", label: t("admin.activity.who.staff") },
              ]}
            />
          </div>
          <Heatmap data={data} who={who} locale={locale} />
          <Legend classHours={classHours} />
          <p className="text-xs text-fg-faint">
            {t("admin.activity.caption", { zone: SCHOOL_TIME_ZONE })}
            {/* Recording began inside the grid: its first days are empty for that reason, not for lack of use. */}
            {data.recordedSince && data.recordedSince > data.days[0]!.date
              ? ` ${t("admin.activity.since", { date: dayLabel(data.recordedSince, locale) })}`
              : null}
          </p>
        </Card>
      )}
    </section>
  );
}

/**
 * Seven dated rows, twenty-four hours: a real table, so a screen reader reads
 * each figure under its day and its hour. The week's sum per hour closes it,
 * as a row of bars on the same columns.
 */
function Heatmap({ data, who, locale }: { data: AdminActivity; who: ActivityWho; locale: Locale }) {
  const t = useT();
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const top = Math.max(0, ...data.days.flatMap((d) => d.hours.map((c) => valueOf(c, who))));
  const sums = hours.map((h) => data.days.reduce((s, d) => s + valueOf(d.hours[h]!, who), 0));
  const topSum = Math.max(1, ...sums);
  const today = data.days.at(-1)?.date;
  return (
    // The grid scrolls inside its card on a phone; the page never does.
    // `relative`: the cells' `sr-only` words are positioned against this
    // box, so they scroll with it instead of widening the page.
    <div className="relative -mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0.5 text-[11px] tabular-nums">
        <caption className="sr-only">{t("admin.activity.grid.title")}</caption>
        <colgroup>
          <col className="w-24" />
          {hours.map((h) => (
            <col key={h} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              {t("admin.activity.day.col")}
            </th>
            {hours.map((h) => (
              <th key={h} scope="col" className="pb-1 text-center font-normal text-fg-faint">
                <span aria-hidden>{h}</span>
                <span className="sr-only">{`${pad(h)}:00`}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.days.map((day) => {
            const label = dayLabel(day.date, locale);
            return (
              <tr key={day.date}>
                <th
                  scope="row"
                  className={cx(
                    "whitespace-nowrap pr-2 text-left text-xs font-normal",
                    day.date === today ? "font-semibold text-fg" : "text-fg-muted",
                  )}
                >
                  {label}
                </th>
                {day.hours.map((cell, h) => {
                  const value = valueOf(cell, who);
                  const step = heatStep(value, top);
                  const off = !isClassHour(day.date, h);
                  const title = t(off ? "admin.activity.cell.off" : "admin.activity.cell", {
                    day: label,
                    from: pad(h),
                    to: pad((h + 1) % 24),
                    n: value,
                  });
                  return (
                    <td
                      key={h}
                      title={title}
                      data-off={off || undefined}
                      className={cx(
                        "h-7 rounded-[3px] p-0 text-center align-middle",
                        step === 0 ? "bg-surface-2 text-fg-faint" : STEPS[step - 1],
                        off && OFF_HOURS,
                      )}
                    >
                      {value > 0 ? value : <span className="sr-only">0</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="pr-2 pt-2 text-left align-bottom text-xs font-normal text-fg-muted">
              {t("admin.activity.byHour")}
            </th>
            {sums.map((sum, h) => (
              <td
                key={h}
                className="h-10 p-0 pt-2 align-bottom"
                title={t("admin.activity.byHour.cell", { from: pad(h), to: pad((h + 1) % 24), n: sum })}
              >
                <div
                  aria-hidden
                  className={cx("mx-auto w-full rounded-t-[3px]", sum > 0 ? "bg-heat-4" : "bg-line")}
                  style={{ height: sum > 0 ? `${Math.max(12, (sum / topSum) * 100)}%` : "2px" }}
                />
                <span className="sr-only">{sum}</span>
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** The ramp, from fewer to more, and what the hatch means. */
function Legend({ classHours }: { classHours: string }) {
  const t = useT();
  const swatch = "inline-block size-3 rounded-[3px]";
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-fg-muted">
      <span className="inline-flex items-center gap-1.5">
        {t("admin.activity.legend.fewer")}
        <span aria-hidden className="inline-flex gap-0.5">
          {STEPS.map((step) => (
            <span key={step} className={cx(swatch, step)} />
          ))}
        </span>
        {t("admin.activity.legend.more")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={cx(swatch, "border border-line bg-surface-2", OFF_HOURS)} />
        {t("admin.activity.legend.off", { window: classHours })}
      </span>
    </div>
  );
}
