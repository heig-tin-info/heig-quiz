/**
 * When the drill is practised (ADR-041 §8, amendment of 2026-10-14): the
 * last 30 days folded on one week, Monday first, hour by hour, on the
 * heatmap of the administrator's activity (DESIGN.md, "The activity
 * heatmap"). The classroom's grid counts the distinct students of each
 * slot, one student's grid their reviews; the off-hours share is in the
 * same unit. A read only: no control, no filter.
 */
import type { DrillHours as DrillHoursData } from "@quiz/contracts";
import { isWeekdayClassHour, SCHOOL_TIME_ZONE } from "@quiz/domain";
import { Clock } from "lucide-react";

import { useI18n, useT, type Locale } from "../i18n";
import { Card, HeatLegend, HourHeatmap, isoDateParts, padHour, percent, QueryError, SectionHeading, Skeleton } from "../ui";
import { useDrillHours } from "./api";

/** Monday 12 October 2026 and the six days after it: the rows' names, Monday first. */
const weekdayLabel = (weekday: number, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 9, 12 + weekday)),
  );

/** The grid, its legend, the off-hours share and what a cell counts; a line instead when nothing was reviewed. */
function HoursBody({ data, student }: { data: DrillHoursData; student: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  if (data.total === 0) return <p className="text-sm text-fg-muted">{t("drill.hours.empty")}</p>;
  return (
    <div className="space-y-3">
      {data.offHoursShare === null ? null : (
        <p className="text-sm text-fg">
          {t("drill.hours.offHours", { share: percent(data.offHoursShare, locale) })}
        </p>
      )}
      <HourHeatmap
        caption={t(student ? "drill.hours.student.title" : "drill.hours.title")}
        rowHeader={t("drill.hours.day")}
        rows={data.days.map((hours, d) => ({ key: String(d), label: weekdayLabel(d, locale), hours }))}
        isClassHour={isWeekdayClassHour}
        cellTitle={(row, h, n, off) => {
          const key = student
            ? n === 1
              ? "drill.hours.cell.reviews.one"
              : "drill.hours.cell.reviews"
            : n === 1
              ? "drill.hours.cell.students.one"
              : "drill.hours.cell.students";
          const cell = t(key, {
            day: row.label,
            from: padHour(h),
            to: padHour((h + 1) % 24),
            n,
          });
          return off ? t("drill.hours.cell.off", { cell }) : cell;
        }}
      />
      <HeatLegend />
      <p className="text-xs text-fg-faint">
        {t(student ? "drill.hours.student.caption" : "drill.hours.caption", {
          date: isoDateParts(`${data.since}T12:00:00Z`).date,
          zone: SCHOOL_TIME_ZONE,
        })}
      </p>
    </div>
  );
}

/** The classroom's grid, under the table of students in the Drill tab. */
export function ClassroomDrillHours({ classroomId }: { classroomId: string }) {
  const t = useT();
  const hours = useDrillHours(classroomId);
  return (
    <section className="space-y-3">
      <SectionHeading icon={Clock} title={t("drill.hours.title")} description={t("drill.hours.desc")} />
      {hours.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : hours.isError || !hours.data ? (
        <QueryError title={t("drill.hours.loadFailed")} query={hours} />
      ) : (
        <Card className="p-4">
          <HoursBody data={hours.data} student={false} />
        </Card>
      )}
    </section>
  );
}

/** One student's grid, in their sheet beside the weekly progression. */
export function StudentDrillHours({ classroomId, enrollmentId }: { classroomId: string; enrollmentId: string }) {
  const t = useT();
  const hours = useDrillHours(classroomId, enrollmentId);
  return (
    <figure className="space-y-3">
      <figcaption className="text-sm font-semibold">{t("drill.hours.student.title")}</figcaption>
      {hours.isLoading ? (
        <Skeleton className="h-56 w-full" />
      ) : hours.isError || !hours.data ? (
        <QueryError title={t("drill.hours.loadFailed")} query={hours} />
      ) : (
        <HoursBody data={hours.data} student />
      )}
    </figure>
  );
}
