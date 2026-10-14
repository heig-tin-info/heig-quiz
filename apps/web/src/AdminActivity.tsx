import { useQuery } from "@tanstack/react-query";
import { ChartColumn } from "lucide-react";
import { useState } from "react";

import type { ActivityCount, AdminActivity } from "@quiz/contracts";
import { isClassHour, SCHOOL_TIME_ZONE, type Locale } from "@quiz/domain";

import { api } from "./api";
import { useI18n, useT } from "./i18n";
import { adminActivityKey } from "./queryKeys";
import {
  Card,
  EmptyState,
  HeatLegend,
  HourHeatmap,
  padHour as pad,
  QueryError,
  SectionHeading,
  Segmented,
  Skeleton,
  Stat,
  useClassHoursWindow,
} from "./ui";

/** Whose activity the grid shows. */
export type ActivityWho = "all" | "students" | "staff";

const valueOf = (cell: ActivityCount, who: ActivityWho): number =>
  who === "all" ? cell.students + cell.staff : cell[who];

const dayLabel = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );

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
  const classHours = useClassHoursWindow();
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
          <HeatLegend />
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
 * Seven dated rows (today last, set apart), twenty-four hours, and the
 * week's sum per hour as a row of bars.
 */
function Heatmap({ data, who, locale }: { data: AdminActivity; who: ActivityWho; locale: Locale }) {
  const t = useT();
  const today = data.days.at(-1)?.date;
  return (
    <HourHeatmap
      caption={t("admin.activity.grid.title")}
      rowHeader={t("admin.activity.day.col")}
      rows={data.days.map((day) => ({
        key: day.date,
        label: dayLabel(day.date, locale),
        strong: day.date === today,
        hours: day.hours.map((c) => valueOf(c, who)),
      }))}
      isClassHour={(r, h) => isClassHour(data.days[r]!.date, h)}
      cellTitle={(row, h, n, off) =>
        t(off ? "admin.activity.cell.off" : "admin.activity.cell", { day: row.label, from: pad(h), to: pad((h + 1) % 24), n })
      }
      footer={{
        label: t("admin.activity.byHour"),
        title: (h, n) => t("admin.activity.byHour.cell", { from: pad(h), to: pad((h + 1) % 24), n }),
      }}
    />
  );
}
