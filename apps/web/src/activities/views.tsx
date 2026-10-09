import { ClipboardCheck, FolderGit2, Hand, NotebookPen, Vote } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ActivitySummary } from "@quiz/contracts";

import { useI18n, useT, type TFunction } from "../i18n";
import type { Route } from "../router";
import {
  Badge,
  Button,
  Card,
  cx,
  isoDateParts,
  pressable,
  RelativeTime,
  T,
  TableHead,
  Tip,
  useSortableTable,
  type Column,
  type IconType,
} from "../ui";
import { ActivityMenu } from "./actions";
import {
  anchorOf,
  bucketOf,
  closedByHand,
  closesOf,
  foldable,
  isoWeek,
  kindOf,
  mondayOf,
  typeOf,
  weeksOf,
  type ActivityType,
} from "./model";

/*
 * The three views of the Activities section (#190), after heig-classroom's
 * classroom list: cards, a sortable list, and a view in time. Every one
 * opens a row where the classroom's own list would (`KIND`'s `home`, `model.ts`) and
 * carries the same overflow menu, so switching views changes the layout and
 * nothing of what a row does.
 */

export const TYPE_ICON: Record<ActivityType, IconType> = {
  exam: ClipboardCheck,
  exercise: NotebookPen,
  poll: Vote,
  project: FolderGit2,
};

/** What a click on a row does: open its kind's `home`. */
export function openerOf(row: ActivitySummary, navigate: (r: Route) => void): () => void {
  return () => navigate(kindOf(row).home(row));
}

/** The click and the keyboard of a row that opens its activity ({@link openerOf}). */
export function openProps(row: ActivitySummary, navigate: (r: Route) => void, role?: string) {
  const open = openerOf(row, navigate);
  return { onClick: open, ...pressable(open, role) };
}

export interface ViewProps {
  rows: ActivitySummary[];
  navigate: (r: Route) => void;
  onEnd: (row: ActivitySummary) => void;
}

/** "Exercise", or "Exercise · take-home" for a series done over days. */
export const modeLabel = (row: ActivitySummary, t: TFunction): string => kindOf(row).typeLabel(row, t);

/** "PRG1 · PRG1-2026", or the word for an anonymous poll's lack of one. */
export function classroomLabel(row: ActivitySummary, t: TFunction): string {
  return row.classroom
    ? `${row.classroom.courseCode} · ${row.classroom.name}`
    : t("activities.noClassroom");
}

/** The state of a row, either kind's: the Activities' views and the classroom's Projects group. */
export function StateBadge({ row }: { row: ActivitySummary }) {
  const t = useT();
  const kind = kindOf(row);
  return <Badge tone={kind.stateTone(row)}>{kind.stateLabel(row, t)}</Badge>;
}

const dateOrDash = (iso: string | null) => (iso === null ? "—" : <RelativeTime iso={iso} />);

/**
 * When a row closes, or closed — a distance, the date on hover (`RelativeTime`)
 * — and a hand where a person ended it rather than its clock. `labelled`
 * says which ("closes in 3 days", "closed 2 weeks ago") where no column
 * heading does.
 */
export function Closing({ row, labelled = false }: { row: ActivitySummary; labelled?: boolean }) {
  const t = useT();
  const at = closesOf(row);
  if (at === null) return <>—</>;
  const label = t("activities.closedByHand");
  return (
    <span className="inline-flex items-center gap-1.5">
      {labelled ? (
        <span>{t(bucketOf(row.state) === "ended" ? "activities.closed" : "activities.closes")}</span>
      ) : null}
      <RelativeTime iso={at} />
      {closedByHand(row) ? (
        <Tip label={label}>
          <Hand aria-hidden className="size-3.5 text-fg-faint" />
          <span className="sr-only">{label}</span>
        </Tip>
      ) : null}
    </span>
  );
}

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
          return closesOf(row) ?? "";
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
            const Icon = TYPE_ICON[typeOf(row)];
            return (
              <tr
                key={row.id}
                className={`${T.row} ${T.rowHover} cursor-pointer`}
                {...openProps(row, navigate, "row")}
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
                <td className={`${T.td} ${T.colLow} text-fg-muted`}>
                  <Closing row={row} />
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
        const Icon = TYPE_ICON[typeOf(row)];
        const anchor = anchorOf(row);
        const closes = closesOf(row);
        return (
          <Card
            key={row.id}
            interactive
            {...openProps(row, navigate)}
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
              {anchor ? <RelativeTime iso={anchor} /> : null}
              {closes ? <Closing row={row} labelled /> : null}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// --- Schedule --------------------------------------------------------------------

/**
 * The schedule on a phone, where the gantt of `Timeline.tsx` has no width to
 * pan in: week by week, Monday first, a semester of weekly series as sixteen
 * short lists. What is open sits in this week, whenever it opened. The weeks
 * behind that hold nothing but ended rows fold under one button, so the page
 * opens on this week; a draft with no date sits last, under "Not scheduled".
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
              const Icon = TYPE_ICON[typeOf(row)];
              const anchor = anchorOf(row);
              const closes = closesOf(row);
              return (
                <div
                  key={row.id}
                  {...openProps(row, navigate)}
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
                      {closes ? (
                        <>
                          {" · "}
                          <Closing row={row} labelled />
                        </>
                      ) : null}
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
