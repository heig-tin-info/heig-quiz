import { useQuery } from "@tanstack/react-query";
import { CalendarRange, LayoutGrid, List, Radio, SearchX, Square } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import type { ActivitySummary, EvaluationActivitySummary } from "@quiz/contracts";

import { api } from "../api";
import { evaluationHome, evaluationStateLabel, stateTone } from "../evaluation/common";
import { useT } from "../i18n";
import { activitiesKey } from "../queryKeys";
import type { Route } from "../router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  iconOption,
  isoDateParts,
  PageHeader,
  QueryError,
  RelativeTime,
  SectionHeading,
  Segmented,
  Skeleton,
  Tabs,
  ToggleChip,
  useMinWidth,
  useNow,
  usePersistentChoice,
} from "../ui";
import { endable, useEndPoll } from "./actions";
import {
  activityOrder,
  awaitsRelease,
  isLive,
  matchesType,
  tabOf,
  TABS,
  typeName,
  typeOf,
  TYPES,
  type ActivityType,
  type Tab,
} from "./model";
import { ActivitiesSummaryTiles, type SummaryTarget } from "./Summary";
import { ActivityTimeline } from "./Timeline";
import {
  ActivityCards,
  ActivitySchedule,
  ActivityTable,
  classroomLabel,
  TYPE_ICON,
  type ViewProps,
} from "./views";

/**
 * The Activities section (issue #190): every exam, exercise and poll the
 * teacher runs, across their classrooms, in one place — a semester of weekly
 * series, the exams, the polls — with what is live right now on top. The
 * projects of those classrooms are listed beside them since M3-10, between
 * their start and their deadline, and never "live".
 *
 * No primary button. Nothing is CREATED here: an exam, an exercise or a
 * project is born in its classroom ("New ▾"), a poll in the launcher, and both are one
 * click away in the sidebar; a "New activity" would be a third, classroom
 * picking door to the same two flows. What this page is for is reaching the
 * activity that needs you, and the "Live now" block is where the eye goes
 * first. The empty state, where there is nothing to reach, offers the one
 * creation that needs no classroom.
 *
 * Three tabs split the list by age: what runs or is planned (the default:
 * what the teacher came for), the drafts nobody launched, and what is over.
 * The type chips narrow whichever tab is open. Above them, the summary
 * tiles (`Summary.tsx`) count what runs, what waits for its results, the
 * week ahead and the projects, each one a way into the rows it counts.
 *
 * The data is one read, refreshed by the SSE hints that already refresh a
 * classroom's list (`activities` is an evaluation root in `realtime/hints.ts`).
 * The filters are client-side. What bounds the list is the server: the
 * evaluations of the classrooms not archived, and the anonymous polls ended
 * in the last 120 days (older ones stay in the launcher's history) — the
 * weekly series of a few classrooms, their exams and a term of polls, a few
 * hundred rows at most. A filter that answers without a round trip is worth
 * more than those bytes.
 */

type View = "cards" | "list" | "schedule";
const VIEWS: readonly View[] = ["cards", "list", "schedule"];

export function ActivitiesPage({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const list = useQuery<ActivitySummary[]>({
    queryKey: activitiesKey,
    queryFn: () => api("/app/api/activities"),
  });
  // "Live" moves with the clock too (a scheduled exam 15 minutes out), not
  // only with the hints: re-evaluated every half minute.
  const now = useNow(30_000);
  const [view, setView] = usePersistentChoice<View>("quiz-activities-view", VIEWS, "list");
  const [types, setTypes] = useState<ReadonlySet<ActivityType>>(new Set());
  const [tab, setTab] = usePersistentChoice<Tab>("quiz-activities-tab", TABS, "current");
  // The Ended tab narrowed to what waits for its results (the summary's tile).
  const [unreleased, setUnreleased] = useState(false);
  const { end, pending } = useEndPoll();
  const wide = useMinWidth(640);

  const ordered = useMemo(() => activityOrder(list.data ?? []), [list.data]);
  const live = ordered.filter((row): row is EvaluationActivitySummary => isLive(row, now));
  const typed = ordered.filter((row) => matchesType(row, types));
  const inTab = (t: Tab) => typed.filter((row) => tabOf(row) === t);
  const narrowing = unreleased && tab === "ended";
  const shown = inTab(tab).filter((row) => !narrowing || awaitsRelease(row));
  const tabTotal = ordered.filter((row) => tabOf(row) === tab).length;
  const filtering = types.size > 0 || narrowing;
  const clearFilters = () => {
    setTypes(new Set());
    setUnreleased(false);
  };
  const pick = (target: SummaryTarget) => {
    clearFilters();
    setTab(target === "toRelease" ? "ended" : "current");
    if (target === "toRelease") setUnreleased(true);
    if (target === "projects") setTypes(new Set(["project"]));
  };
  // A type chip only where there is a row of that type to find: a chip that
  // can only empty the list is noise (a platform without projects keeps the
  // three it had).
  const chips = TYPES.filter((type) => ordered.some((row) => typeOf(row) === type));

  const toggle = <V,>(set: ReadonlySet<V>, value: V): Set<V> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };


  const props: ViewProps = { rows: shown, navigate, onEnd: end };
  let body: ReactNode;
  if (list.isLoading) {
    body = <Skeleton className="h-64 w-full" />;
  } else if (list.isError || !list.data) {
    body = (
      <QueryError title={t("activities.loadFailed")} query={list} />
    );
  } else if (ordered.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={CalendarRange}
          title={t("activities.empty.title")}
          action={<Button onClick={() => navigate({ view: "polls" })}>{t("poll.start")}</Button>}
        >
          {t("activities.empty.body")}
        </EmptyState>
      </Card>
    );
  } else if (shown.length === 0 && !filtering) {
    body = (
      <Card>
        <EmptyState icon={CalendarRange} title={t(`activities.tab.${tab}.empty`)} />
      </Card>
    );
  } else if (shown.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={SearchX}
          title={t("activities.filtered.title")}
          action={
            <Button
              variant="secondary"
              onClick={clearFilters}
            >
              {t("activities.filtered.clear")}
            </Button>
          }
        />
      </Card>
    );
  } else if (view === "cards") {
    body = <ActivityCards {...props} />;
  } else if (view === "schedule") {
    // The gantt needs width; below `sm` it is the week list (views.tsx).
    body = wide ? (
      <ActivityTimeline rows={shown} navigate={navigate} now={now} />
    ) : (
      <ActivitySchedule {...props} now={now} />
    );
  } else {
    body = <ActivityTable {...props} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("activities.title")} description={t("activities.subtitle")} />

      {ordered.length > 0 ? <ActivitiesSummaryTiles rows={ordered} now={now} onPick={pick} /> : null}

      {live.length > 0 ? (
        <LiveNow rows={live} navigate={navigate} onEnd={end} pending={pending} />
      ) : null}

      {ordered.length > 0 ? (
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          label={t("activities.tabs")}
          items={TABS.map((value) => ({
            value,
            label: t(`activities.tab.${value}`),
            count: inTab(value).length,
          }))}
        />
      ) : null}

      {ordered.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t("activities.filter.type")} className="flex flex-wrap gap-2">
            {chips.map((type) => (
              <ToggleChip
                key={type}
                icon={TYPE_ICON[type]}
                label={typeName(type, t)}
                pressed={types.has(type)}
                onToggle={() => setTypes((s) => toggle(s, type))}
              />
            ))}
          </div>
          {/* Only where it can find something: the Ended tab, holding a run
              whose results are not out. */}
          {tab === "ended" && ordered.some(awaitsRelease) ? (
            <>
              <span aria-hidden className="mx-1 hidden h-5 w-px bg-line sm:block" />
              <ToggleChip
                label={t("activities.filter.unreleased")}
                pressed={unreleased}
                onToggle={() => setUnreleased((v) => !v)}
              />
            </>
          ) : null}
          <span className="flex-1" />
          <Segmented
            name="activities-view"
            value={view}
            onChange={setView}
            options={[
              iconOption("list", <List className="size-4" />, t("view.list")),
              iconOption("cards", <LayoutGrid className="size-4" />, t("view.cards")),
              iconOption("schedule", <CalendarRange className="size-4" />, t("view.schedule")),
            ]}
          />
        </div>
      ) : null}

      {filtering && shown.length > 0 ? (
        <p className="-mt-3 text-[13px] text-fg-muted">
          {t("activities.filtered.count", { n: shown.length, total: tabTotal })}
        </p>
      ) : null}

      {body}
    </div>
  );
}

/**
 * What is live right now — the deploy guard's definition, `isLiveNow` — and
 * nothing else: shown only when it has rows, whatever the filters below say,
 * because it is the one place a forgotten poll or an exam about to open can
 * never hide. Each row says since when and until when, opens where the class
 * is (the dashboard, the projection), and a running poll ends from here.
 */
function LiveNow({
  rows,
  navigate,
  onEnd,
  pending,
}: {
  rows: EvaluationActivitySummary[];
  navigate: (r: Route) => void;
  onEnd: (row: EvaluationActivitySummary) => void;
  pending: string | null;
}) {
  const t = useT();
  return (
    <section aria-labelledby="activities-live" className="space-y-3">
      <SectionHeading
        icon={Radio}
        title={<span id="activities-live">{t("activities.live.title")}</span>}
        count={rows.length}
      />
      <Card className="divide-y divide-line">
        {rows.map((row) => {
          const Icon = TYPE_ICON[row.mode];
          return (
            // A phone stacks the facts over the buttons; a desktop keeps one line.
            <div key={row.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Icon aria-hidden className="size-4 shrink-0 text-fg-faint" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{row.title}</p>
                  <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-fg-muted">
                    <span>{classroomLabel(row, t)}</span>
                    <Since row={row} />
                    {row.closesAt ? (
                      <span className="tabular-nums">
                        {t("activities.live.closesAt", { time: isoDateParts(row.closesAt).time })}
                      </span>
                    ) : null}
                  </p>
                </div>
              </div>
              <span className="flex shrink-0 flex-wrap items-center gap-2 pl-7 sm:pl-0">
                <Badge tone={stateTone(row.state)}>{evaluationStateLabel(row.state, t)}</Badge>
                <Button size="sm" variant="secondary" onClick={() => navigate(evaluationHome(row))}>
                  {row.mode === "poll" ? t("poll.openProjection") : t("eval.dashboard")}
                </Button>
                {endable(row) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onEnd(row)}
                    loading={pending === row.id}
                    aria-label={t("activities.live.end", { name: row.title })}
                  >
                    <Square className="fill-current" /> {t("poll.end")}
                  </Button>
                ) : null}
              </span>
            </div>
          );
        })}
      </Card>
    </section>
  );
}

/** "Started 25 minutes ago", or "Opens in 10 minutes" for one about to. */
function Since({ row }: { row: EvaluationActivitySummary }) {
  const t = useT();
  if (row.state === "scheduled" && row.opensAt) {
    return (
      <span>
        {t("activities.live.opens")} <RelativeTime iso={row.opensAt} />
      </span>
    );
  }
  if (row.startedAt) {
    return (
      <span>
        {t("activities.live.started")} <RelativeTime iso={row.startedAt} />
      </span>
    );
  }
  return null;
}
