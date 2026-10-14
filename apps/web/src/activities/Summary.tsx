import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Check, FolderGit2, Radio, Send } from "lucide-react";
import type { ReactNode } from "react";

import type { ActivityStats, ActivitySummary, ProjectActivitySummary } from "@quiz/contracts";

import { api } from "../api";
import { useI18n, useT, type Locale, type TFunction } from "../i18n";
import { activityStatsKey } from "../queryKeys";
import { cx, percent, relativeTime, SegmentedBar, Stat } from "../ui";
import {
  classSegments,
  projectProgress,
  summaryOf,
  type ActivitiesSummary,
  type NextEvent,
  type SummaryDay,
  type Waiting,
} from "./model";

/** Where a tile leads: the tab it counts, narrowed as it counts. */
export type SummaryTarget = "open" | "toRelease" | "week" | "projects";

/**
 * The tiles above the Activities (#190 follow-up): what runs and how many
 * students it involves, what waits for its results to go out, what happens
 * in the next seven days, and the projects' next deadline. Each tile is one
 * button leading to the rows it counts, and shows WHAT its figure counts (a
 * segment per open activity, the titles that wait, the events by day, the
 * project's elapsed time) with nothing focusable inside; none is an action
 * of its own (the page has no primary button). One semantic tone per tile,
 * never the accent (DESIGN.md › The Activities summary). Only the students
 * come from the server (`GET /activities/stats`); the rest is counted from
 * the rows the page already holds, by the rules of `summaryOf`.
 */
export function ActivitiesSummaryTiles({
  rows,
  now,
  onPick,
}: {
  rows: readonly ActivitySummary[];
  now: number;
  onPick: (target: SummaryTarget) => void;
}) {
  const stats = useQuery<ActivityStats>({
    queryKey: activityStatsKey,
    queryFn: () => api("/app/api/activities/stats"),
  });
  const summary = summaryOf(rows, now);
  return (
    // Three tiles: the last takes the phone's whole second row.
    <div
      className={cx(
        "grid grid-cols-2 gap-3",
        summary.projects ? "lg:grid-cols-4" : "lg:grid-cols-3 [&>:last-child]:col-span-2 lg:[&>:last-child]:col-span-1",
      )}
    >
      <OpenTile count={summary.open} stats={stats.data} onClick={() => onPick("open")} />
      <ReleaseTile count={summary.toRelease} waiting={summary.waiting} now={now} onClick={() => onPick("toRelease")} />
      <WeekTile week={summary.week} now={now} onClick={() => onPick("week")} />
      {summary.projects ? (
        <ProjectsTile projects={summary.projects} now={now} onClick={() => onPick("projects")} />
      ) : null}
    </div>
  );
}

type TileProps = { now: number; onClick: () => void };

/** The big figure and what it counts, beside it: "7 open activities". A zero is faint. */
function Figure({ n, unit }: { n: number; unit: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className={cx("text-[32px] font-extrabold leading-tight", n === 0 && "text-fg-faint")}>{n}</span>
      <span className="text-[13px] font-normal tracking-normal text-fg-muted">{unit}</span>
    </span>
  );
}

/** A small rounded word on the label's line, in its tile's tone: "live", "to do". */
function Chip({ tone, children }: { tone: "success" | "warning"; children: ReactNode }) {
  return (
    <span
      className={cx(
        "-my-0.5 inline-flex items-center gap-1.5 whitespace-nowrap rounded-control px-2 py-0.5 text-xs font-semibold",
        tone === "success" ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
      )}
    >
      {children}
    </span>
  );
}

/** The tile's last line, on its bottom edge whatever the tiles beside it hold. */
const Foot = ({ children }: { children: ReactNode }) => (
  <span className="mt-auto block pt-1 leading-snug">{children}</span>
);


/**
 * In progress: a green "live" chip whose dot pulses (still under reduced
 * motion), the open activities, and a bar of one segment per open activity
 * that has a classroom, each as wide as its class — what the figure weighs,
 * without a number.
 */
function OpenTile({ count, stats, onClick }: { count: number; stats: ActivityStats | undefined; onClick: () => void }) {
  const t = useT();
  const segments = count > 0 ? classSegments(stats?.classSizes ?? []) : [];
  const students = stats?.studentsInProgress;
  return (
    <Stat
      icon={Radio}
      label={t("activities.summary.open")}
      aside={
        count > 0 ? (
          <Chip tone="success">
            <span className="relative flex size-1.5">
              <span className="absolute inset-0 rounded-full bg-success opacity-60 motion-safe:animate-ping" />
              <span className="relative size-1.5 rounded-full bg-success" />
            </span>
            {t("activities.summary.live")}
          </Chip>
        ) : null
      }
      value={
        <Figure
          n={count}
          unit={
            count === 0
              ? t("activities.summary.open.none")
              : t(count === 1 ? "activities.summary.open.unit.one" : "activities.summary.open.unit")
          }
        />
      }
      onClick={onClick}
    >
      <SegmentedBar className="h-1.5" parts={segments.map((value) => ({ tone: "success", value }))} />
      {students === undefined ? null : (
        <Foot>
          {students === 0 ? (
            t("activities.summary.students.none")
          ) : (
            <>
              <strong className="font-semibold tabular-nums text-fg">{students}</strong>{" "}
              {t(students === 1 ? "activities.summary.students.unit.one" : "activities.summary.students.unit")}
            </>
          )}
        </Foot>
      )}
    </Stat>
  );
}

/**
 * Results to release: the figure is every run whose results are not out; the
 * amber "to do" and the titles name only those that wait on the staff (an
 * exam closed, a run in grading), the longest waiting first.
 */
function ReleaseTile({ count, waiting, now, onClick }: TileProps & { count: number; waiting: Waiting[] }) {
  const t = useT();
  const { locale } = useI18n();
  return (
    <Stat
      icon={Send}
      label={t("activities.summary.toRelease")}
      aside={waiting.length > 0 ? <Chip tone="warning">{t("activities.summary.toRelease.todo")}</Chip> : null}
      value={
        <Figure
          n={count}
          unit={count === 0 ? t("activities.summary.toRelease.none") : t("activities.summary.toRelease.unit")}
        />
      }
      onClick={onClick}
    >
      {waiting.length > 0 ? (
        <span className="grid gap-1">
          {waiting.slice(0, WAITING_SHOWN).map(({ row, since }) => (
            <span key={row.id} className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
              <span className="truncate text-fg">{row.title}</span>
              {since === null ? null : (
                <span className="ml-auto shrink-0 pl-1 font-mono text-[11px] text-fg-faint">
                  {relativeTime(since, now, locale, t, "short")}
                </span>
              )}
            </span>
          ))}
        </span>
      ) : count === 0 ? (
        <Foot>
          <span className="inline-flex items-center gap-1">
            <Check aria-hidden className="size-3.5 text-success" />
            {t("activities.summary.toRelease.nothing")}
          </span>
        </Foot>
      ) : (
        <Foot>{t("activities.summary.toRelease.hint")}</Foot>
      )}
    </Stat>
  );
}

/** The titles a tile names: two keep the four tiles one height; the figure says how many there are. */
const WAITING_SHOWN = 2;

/**
 * The next seven calendar days: the events (openings and closings) counted
 * on the label's line, a bar per day as tall as its events, the next event's
 * day in `info`, the other busy days in `info-mid`, an empty day a stub.
 */
function WeekTile({ week, now, onClick }: TileProps & { week: ActivitiesSummary["week"] }) {
  const t = useT();
  const { locale } = useI18n();
  const next = week.next;
  const nextDay = next === null ? null : (week.days.find((d) => d.events.includes(next)) ?? null);
  return (
    <Stat
      icon={CalendarClock}
      label={t("activities.summary.week")}
      aside={
        week.count > 0 ? (
          <span className="whitespace-nowrap text-fg">
            <b className="font-bold tabular-nums">{week.count}</b>{" "}
            {t(week.count === 1 ? "activities.summary.week.unit.one" : "activities.summary.week.unit")}
          </span>
        ) : null
      }
      value={<DayStrip days={week.days} next={nextDay} locale={locale} />}
      onClick={onClick}
    >
      <Foot>
        {next === null ? (
          t("activities.summary.week.none")
        ) : (
          <>
            {t("activities.summary.week.next")} <strong className="font-semibold text-fg">{next.row.title}</strong>{" "}
            {nextEventWhen(next, now, locale, t)}
          </>
        )}
      </Foot>
    </Stat>
  );
}

/** The tallest day's bar, in px; an empty day is a 3 px stub, a busy one at least 8. */
const STRIP_PX = 30;

function DayStrip({ days, next, locale }: { days: SummaryDay[]; next: SummaryDay | null; locale: Locale }) {
  const most = Math.max(1, ...days.map((d) => d.events.length));
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
  return (
    <span aria-hidden className="mt-1 grid grid-cols-7 items-end gap-1">
      {days.map((day, i) => (
        <span key={day.start} className="flex flex-col items-center justify-end gap-1" style={{ height: STRIP_PX + 14 }}>
          <span
            className={cx(
              "w-full rounded-[4px]",
              day === next ? "bg-info" : day.events.length > 0 ? "bg-info-mid" : "bg-surface-3",
            )}
            style={{ height: day.events.length === 0 ? 3 : Math.max(8, (day.events.length / most) * STRIP_PX) }}
          />
          <span
            className={cx(
              "font-mono text-[10px] leading-none",
              i === 0 ? "font-bold text-fg" : "font-medium text-fg-faint",
            )}
          >
            {weekday.format(day.start)}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * Projects in progress: their count on the label's line, the running one
 * whose deadline comes first and its date, and how much of its time has
 * passed — in ink, amber under 48 hours. No bar without both dates.
 */
function ProjectsTile({ projects, now, onClick }: TileProps & { projects: NonNullable<ActivitiesSummary["projects"]> }) {
  const t = useT();
  const { locale } = useI18n();
  const next = projects.next;
  const row = next?.row as ProjectActivitySummary | undefined;
  const progress = row ? projectProgress(row.startAt, row.deadlineAt, now) : null;
  const date = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "short" });
  return (
    <Stat
      icon={FolderGit2}
      label={t("activities.summary.projects")}
      aside={next ? <b className="font-bold text-fg">{projects.count}</b> : null}
      value={
        next ? (
          <span className="mt-2 block truncate text-base font-bold leading-snug tracking-normal">{next.row.title}</span>
        ) : (
          <Figure n={projects.count} unit={t("activities.summary.projects.unit")} />
        )
      }
      onClick={onClick}
    >
      {next ? (
        <span className="-mt-2.5 block">
          {t("activities.summary.closes")} {date.format(new Date(next.at))}
        </span>
      ) : (
        <Foot>{t("activities.summary.projects.none")}</Foot>
      )}
      {progress ? (
        <span className="mt-auto block pt-2">
          <SegmentedBar
            className="h-1.5"
            total={1}
            parts={[{ tone: progress.soon ? "warning" : "fg", value: progress.elapsed }]}
          />
          <span className="mt-1.5 flex justify-between font-mono text-[11px] text-fg-faint">
            <span>{t("activities.summary.projects.daysLeft", { n: progress.daysLeft })}</span>
            <span>{t("activities.summary.projects.elapsed", { p: percent(progress.elapsed, locale) })}</span>
          </span>
        </span>
      ) : null}
    </Stat>
  );
}

/** What happens to the row and when: "opens in 3 days", "closes in 2 hours" — the tiles' and the classroom rows' words. */
export function nextEventWhen(event: NextEvent, now: number, locale: Locale, t: TFunction): string {
  return `${t(event.what === "opens" ? "activities.summary.opens" : "activities.summary.closes")} ${relativeTime(event.at, now, locale, t)}`;
}
