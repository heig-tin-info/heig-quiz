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
import type { ReactNode } from "react";

import { useI18n, useT, type Locale } from "../i18n";
import { Card, HeatLegend, HourHeatmap, isoDateParts, padHour, percent, QueryError, SectionHeading, Skeleton } from "../ui";
import { useDrillHours } from "./api";

/**
 * A weekday's short name, Monday (0) first. The app has no shared helper for
 * it (the calendars build theirs inline): any known Monday serves as the
 * reference, read in UTC.
 */
const weekdayLabel = (weekday: number, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, 1 + weekday)), // 2024-01-01 is a Monday
  );

/** What a cell's sentence says, by grid and by number. */
const CELL = {
  students: { one: "drill.hours.cell.students.one", many: "drill.hours.cell.students" },
  reviews: { one: "drill.hours.cell.reviews.one", many: "drill.hours.cell.reviews" },
} as const;

/** The grid, its legend, the off-hours share and what a cell counts; one line instead when nothing was reviewed. */
function HoursBody({ data, student }: { data: DrillHoursData; student: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  if (data.offHoursShare === null) return <p className="text-sm text-fg-muted">{t("drill.hours.empty")}</p>;
  const cell = CELL[student ? "reviews" : "students"];
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg">{t("drill.hours.offHours", { share: percent(data.offHoursShare, locale) })}</p>
      <HourHeatmap
        compact={student}
        caption={t(student ? "drill.hours.student.title" : "drill.hours.title")}
        rowHeader={t("drill.hours.day")}
        rows={data.days.map((hours, d) => ({ key: String(d), label: weekdayLabel(d, locale), hours }))}
        isClassHour={isWeekdayClassHour}
        cellTitle={(row, h, n, off) => {
          const said = t(n === 1 ? cell.one : cell.many, { day: row.label, from: padHour(h), to: padHour((h + 1) % 24), n });
          return off ? t("drill.hours.cell.off", { cell: said }) : said;
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

/** One grid's query and its states: a skeleton, a retry, or the body inside `frame`. */
function DrillHoursQuery({
  classroomId,
  student,
  frame = (body) => body,
}: {
  classroomId: string;
  student?: string;
  frame?: (body: ReactNode) => ReactNode;
}) {
  const t = useT();
  const hours = useDrillHours(classroomId, student);
  if (hours.isLoading) return <Skeleton className="h-56 w-full" />;
  if (hours.isError || !hours.data) return <QueryError title={t("drill.hours.loadFailed")} query={hours} />;
  return frame(<HoursBody data={hours.data} student={student !== undefined} />);
}

/** The classroom's grid, under the table of students in the Drill tab. */
export function ClassroomDrillHours({ classroomId }: { classroomId: string }) {
  const t = useT();
  return (
    <section className="space-y-3">
      <SectionHeading icon={Clock} title={t("drill.hours.title")} description={t("drill.hours.desc")} />
      <DrillHoursQuery classroomId={classroomId} frame={(body) => <Card className="p-4">{body}</Card>} />
    </section>
  );
}

/** One student's grid, in their sheet below the weekly progression. */
export function StudentDrillHours({ classroomId, enrollmentId }: { classroomId: string; enrollmentId: string }) {
  const t = useT();
  return (
    <figure className="space-y-3">
      <figcaption className="text-sm font-semibold">{t("drill.hours.student.title")}</figcaption>
      <DrillHoursQuery classroomId={classroomId} student={enrollmentId} />
    </figure>
  );
}
