import { useQuery } from "@tanstack/react-query";
import { CalendarClock, FolderGit2, Radio, Send } from "lucide-react";

import type { ActivityStats, ActivitySummary } from "@quiz/contracts";

import { api } from "../api";
import { useI18n, useT } from "../i18n";
import { activityStatsKey } from "../queryKeys";
import { cx, relativeTime, Stat } from "../ui";
import { summaryOf, type NextEvent } from "./model";

/** Where a tile leads: the tab it counts, narrowed as it counts. */
export type SummaryTarget = "open" | "toRelease" | "week" | "projects";

/**
 * The tiles above the Activities (#190 follow-up): what runs and how many
 * students it involves, what waits for its results to go out, what happens
 * in the next seven days, and the projects' next deadline. Each tile leads
 * to the rows it counts; none is an action of its own (the page has no
 * primary button). Only the students come from the server
 * (`GET /activities/stats`); the rest is counted from the rows the page
 * already holds, by the rules of `summaryOf`.
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
  const t = useT();
  const stats = useQuery<ActivityStats>({
    queryKey: activityStatsKey,
    queryFn: () => api("/app/api/activities/stats"),
  });
  const summary = summaryOf(rows, now);
  const students = stats.data?.studentsInProgress;
  return (
    // Three tiles: the last takes the phone's whole second row.
    <div
      className={cx(
        "grid grid-cols-2 gap-3",
        summary.projects ? "lg:grid-cols-4" : "lg:grid-cols-3 [&>:last-child]:col-span-2 lg:[&>:last-child]:col-span-1",
      )}
    >
      <Stat
        icon={Radio}
        label={t("activities.summary.open")}
        value={summary.open}
        hint={
          students === undefined
            ? undefined
            : t(students === 1 ? "activities.summary.students.one" : "activities.summary.students", { n: students })
        }
        onClick={() => onPick("open")}
      />
      <Stat
        icon={Send}
        label={t("activities.summary.toRelease")}
        value={summary.toRelease}
        hint={t("activities.summary.toRelease.hint")}
        onClick={() => onPick("toRelease")}
      />
      <Stat
        icon={CalendarClock}
        label={t("activities.summary.week")}
        value={summary.week.count}
        hint={<Next event={summary.week.next} now={now} empty={t("activities.summary.week.none")} />}
        onClick={() => onPick("week")}
      />
      {summary.projects ? (
        <Stat
          icon={FolderGit2}
          label={t("activities.summary.projects")}
          value={summary.projects.count}
          hint={<Next event={summary.projects.next} now={now} empty={t("activities.summary.projects.none")} />}
          onClick={() => onPick("projects")}
        />
      ) : null}
    </div>
  );
}

/**
 * "Série 6 opens in 3 days" — the title, what happens, and when. Plain text,
 * not `RelativeTime`: its tooltip is a focus stop, and the tile is already a
 * button.
 */
function Next({ event, now, empty }: { event: NextEvent | null; now: number; empty: string }) {
  const t = useT();
  const { locale } = useI18n();
  if (event === null) return <>{empty}</>;
  return (
    <>
      <span className="block truncate">{event.row.title}</span>
      <span className="block">
        {t(event.what === "opens" ? "activities.summary.opens" : "activities.summary.closes")}{" "}
        {relativeTime(event.at, now, locale, t)}
      </span>
    </>
  );
}
