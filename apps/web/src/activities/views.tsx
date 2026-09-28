import { ClipboardCheck, NotebookPen, Vote } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ActivitySummary, EvaluationMode } from "@quiz/contracts";

import { evaluationHome, evaluationStateLabel, stateTone } from "../evaluation/common";
import { useI18n, useT, type TFunction } from "../i18n";
import type { Route } from "../router";
import {
  Badge,
  Button,
  Card,
  cx,
  isoDateParts,
  isoDateTime,
  pressable,
  T,
  TableHead,
  useSortableTable,
  type Column,
  type IconType,
} from "../ui";
import { ActivityMenu } from "./actions";
import { anchorOf, foldable, isoWeek, mondayOf, weeksOf } from "./model";

/*
 * The three views of the Activities section (#190), after heig-classroom's
 * classroom list: cards, a sortable list, and a view in time. Every one
 * opens a row where the classroom's own list would (`evaluationHome`) and
 * carries the same overflow menu, so switching views changes the layout and
 * nothing of what a row does.
 */

export const MODE_ICON: Record<EvaluationMode, IconType> = {
  exam: ClipboardCheck,
  exercise: NotebookPen,
  poll: Vote,
};

export interface ViewProps {
  rows: ActivitySummary[];
  navigate: (r: Route) => void;
  onEnd: (row: ActivitySummary) => void;
}

/** "Exercise", or "Exercise · take-home" for a series done over days. */
export function modeLabel(row: ActivitySummary, t: TFunction): string {
  const mode = t(`eval.mode.${row.mode}`);
  return row.takeHome ? `${mode} · ${t("activities.takeHome")}` : mode;
}

/** "PRG1 · PRG1-2026", or the word for an anonymous poll's lack of one. */
export function classroomLabel(row: ActivitySummary, t: TFunction): string {
  return row.classroom
    ? `${row.classroom.courseCode} · ${row.classroom.name}`
    : t("activities.noClassroom");
}

function StateBadge({ row }: { row: ActivitySummary }) {
  const t = useT();
  return <Badge tone={stateTone(row.state)}>{evaluationStateLabel(row.state, t)}</Badge>;
}

const dateOrDash = (iso: string | null) => (iso === null ? "—" : isoDateTime(iso));

// --- List ------------------------------------------------------------------------

type SortKey = "title" | "mode" | "classroom" | "when" | "closes";

export function ActivityTable({ rows, navigate, onEnd }: ViewProps) {
  const t = useT();
  // No initial sort: the rows arrive in `activityOrder`, which is the answer
  // to "what needs me" nobody clicked for. A click on a label replaces it.
  const { sorted, sort, toggle } = useSortableTable<ActivitySummary, SortKey>(
    rows,
    (row, key) => {
      switch (key) {
        case "mode":
          return modeLabel(row, t);
        case "classroom":
          return classroomLabel(row, t);
        case "when":
          return anchorOf(row) ?? "";
        case "closes":
          return row.closesAt ?? "";
        default:
          return row.title;
      }
    },
    null,
  );
  const columns: Column<SortKey>[] = [
    { key: "title", label: t("activities.col.title") },
    { key: "mode", label: t("eval.mode"), className: T.colMid },
    { key: "classroom", label: t("activities.col.classroom"), className: T.colHigh },
    { key: "when", label: t("activities.col.when"), className: T.colHigh },
    { key: "closes", label: t("activities.col.closes"), className: T.colLow },
    { key: "actions", label: t("common.actions"), sortable: false, srOnly: true, className: "w-10" },
  ];
  return (
    <Card className={`${T.container} overflow-hidden`}>
      <table className={T.table}>
        <TableHead columns={columns} sort={sort} onToggle={toggle} />
        <tbody>
          {sorted.map((row) => {
            const open = () => navigate(evaluationHome(row));
            const Icon = MODE_ICON[row.mode];
            return (
              <tr
                key={row.id}
                className={`${T.row} ${T.rowHover} cursor-pointer`}
                onClick={open}
                {...pressable(open, "row")}
              >
                <td className={T.td}>
                  <span className="flex flex-wrap items-center gap-2">
                    <Icon aria-hidden className="size-4 shrink-0 text-fg-faint" />
                    <span className="font-semibold">{row.title}</span>
                    <StateBadge row={row} />
                  </span>
                  {/* Where the classroom column has left (a phone, a narrow
                      card), its label rides under the title: two series of
                      the same name in two classrooms must still read apart. */}
                  <span className="mt-0.5 block pl-6 text-fg-muted @2xl:hidden">
                    {classroomLabel(row, t)}
                  </span>
                </td>
                <td className={`${T.td} ${T.colMid} text-fg-muted`}>{modeLabel(row, t)}</td>
                <td className={`${T.td} ${T.colHigh} text-fg-muted`}>{classroomLabel(row, t)}</td>
                <td className={`${T.td} ${T.colHigh} tabular-nums text-fg-muted`}>
                  {dateOrDash(anchorOf(row))}
                </td>
                <td className={`${T.td} ${T.colLow} tabular-nums text-fg-muted`}>
                  {dateOrDash(row.closesAt)}
                </td>
                <td className={`${T.td} text-right`}>
                  <ActivityMenu row={row} navigate={navigate} onEnd={onEnd} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

// --- Cards -----------------------------------------------------------------------

export function ActivityCards({ rows, navigate, onEnd }: ViewProps) {
  const t = useT();
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => {
        const open = () => navigate(evaluationHome(row));
        const Icon = MODE_ICON[row.mode];
        const anchor = anchorOf(row);
        return (
          <Card
            key={row.id}
            interactive
            onClick={open}
            {...pressable(open)}
            aria-label={row.title}
            className="flex flex-col gap-3 p-5"
          >
            <div className="flex items-center gap-2 text-[13px] text-fg-muted">
              <Icon aria-hidden className="size-4 shrink-0 text-fg-faint" />
              <span className="min-w-0 flex-1 truncate">{modeLabel(row, t)}</span>
              <ActivityMenu row={row} navigate={navigate} onEnd={onEnd} />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-base font-bold tracking-tight">{row.title}</h3>
              <p className="truncate text-[13px] text-fg-muted">{classroomLabel(row, t)}</p>
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-muted">
              <StateBadge row={row} />
              {anchor ? <span className="tabular-nums">{isoDateTime(anchor)}</span> : null}
              {row.closesAt ? (
                <span className="tabular-nums">
                  {t("activities.closes", { at: isoDateTime(row.closesAt) })}
                </span>
              ) : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// --- Schedule --------------------------------------------------------------------

/**
 * Week by week, Monday first: a semester of weekly series reads as sixteen
 * short lists instead of one long one. What is open sits in this week,
 * whenever it opened. The weeks behind that hold nothing but ended rows fold under
 * one button, so the page opens on this week; a draft with no date sits
 * last, under "Not scheduled". heig-classroom draws a pannable gantt here;
 * a list per week says the same for activities that mostly last an hour or
 * a week, and it survives a phone.
 */
export function ActivitySchedule({ rows, navigate, onEnd, now }: ViewProps & { now: number }) {
  const t = useT();
  const { locale } = useI18n();
  const [showPast, setShowPast] = useState(false);
  const thisWeek = mondayOf(now);
  const weeks = weeksOf(rows, now);
  const past = weeks.filter((w) => foldable(w, now));
  const shown = showPast ? weeks : weeks.filter((w) => !past.includes(w));
  // "Mon 28" / "lun. 28": the weekday first in both languages (Intl alone
  // writes "28 Mon" in English).
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const day = (d: Date) => `${weekday.format(d)} ${d.getDate()}`;
  const range = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });

  const heading = (start: number | null): ReactNode => {
    if (start === null) return t("activities.week.undated");
    const sunday = new Date(start);
    sunday.setDate(sunday.getDate() + 6);
    const label = t("activities.week", {
      n: isoWeek(start),
      from: range.format(start),
      to: range.format(sunday),
    });
    const tag =
      start === thisWeek
        ? t("activities.week.this")
        : start === mondayOf(thisWeek + 8 * 86_400_000)
          ? t("activities.week.next")
          : null;
    return (
      <>
        {label}
        {tag ? (
          <Badge tone="zinc" className="ml-2 align-middle">
            {tag}
          </Badge>
        ) : null}
      </>
    );
  };

  return (
    <div className="space-y-6">
      {past.length > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => setShowPast((v) => !v)}>
          {showPast
            ? t("activities.week.hidePast")
            : t(past.length === 1 ? "activities.week.showPast.one" : "activities.week.showPast", {
                n: past.length,
              })}
        </Button>
      ) : null}
      {shown.map((week) => (
        <section key={week.start ?? "undated"} aria-label={week.start === null ? t("activities.week.undated") : undefined}>
          <h2
            className={cx(
              "mb-2 text-sm font-semibold",
              week.start === thisWeek ? "text-fg" : "text-fg-muted",
            )}
          >
            {heading(week.start)}
          </h2>
          <Card className="divide-y divide-line overflow-hidden">
            {week.rows.map((row) => {
              const open = () => navigate(evaluationHome(row));
              const Icon = MODE_ICON[row.mode];
              const anchor = anchorOf(row);
              return (
                <div
                  key={row.id}
                  onClick={open}
                  {...pressable(open)}
                  className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-2/70"
                >
                  <span className="w-14 shrink-0 tabular-nums text-fg-muted">
                    {anchor ? (
                      <>
                        <span className="block font-medium text-fg">{day(new Date(anchor))}</span>
                        {isoDateParts(anchor).time}
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                  {/* Off on a phone: the title needs the width more than the type does. */}
                  <Icon aria-hidden className="hidden size-4 shrink-0 text-fg-faint sm:block" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{row.title}</span>
                    <span className="block truncate text-fg-muted">
                      {classroomLabel(row, t)}
                      {row.closesAt ? ` · ${t("activities.closes", { at: isoDateTime(row.closesAt) })}` : ""}
                    </span>
                  </span>
                  <StateBadge row={row} />
                  <ActivityMenu row={row} navigate={navigate} onEnd={onEnd} />
                </div>
              );
            })}
          </Card>
        </section>
      ))}
      {shown.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("activities.week.nothingAhead")}</p>
      ) : null}
    </div>
  );
}
