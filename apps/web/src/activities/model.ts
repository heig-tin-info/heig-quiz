/*
 * The pure half of the Activities section (#190): which bucket a state falls
 * in, what each KIND of activity answers, the default order, and the weeks
 * of the schedule. No component, so every rule is unit-tested on its own.
 *
 * "Live" is not decided here: it is `isLiveNow` of `@quiz/domain`, the deploy
 * guard's definition, so the section and the guard can never disagree. A
 * project (M3-10) is never live: it runs for weeks, nobody is "in the room".
 */
import type {
  ActivitySummary,
  EvaluationActivitySummary,
  EvaluationMode,
  EvaluationState,
  ProjectState,
} from "@quiz/contracts";
import { activityBucket, isLiveNow, type ActivityBucket } from "@quiz/domain";

import { evaluationHome, evaluationStateLabel, stateTone } from "../evaluation/common";
import type { TFunction } from "../i18n";
import { projectStateLabel, projectStateTone } from "../project/common";
import type { Route } from "../router";
import type { Tone } from "../ui";

/** The three ages of an activity (`activityBucket`, shared with the server). */
export type Bucket = ActivityBucket;

/**
 * The tabs of the section: what runs or is planned (the default — what needs
 * the teacher), what is not launched yet, and what is over. A draft is
 * "upcoming" by its age but not by its tab: nothing is planned for it.
 */
export type Tab = "current" | "drafts" | "ended";
export const TABS: readonly Tab[] = ["current", "drafts", "ended"];

export function tabOf(a: ActivitySummary): Tab {
  if (a.state === "draft") return "drafts";
  return bucketOf(a.state) === "ended" ? "ended" : "current";
}

/** What the type chips filter on: an evaluation's mode, or "project". */
export type ActivityType = EvaluationMode | "project";
export const TYPES: readonly ActivityType[] = ["exam", "exercise", "poll", "project"];

/** A type chip's word: an evaluation's mode, or "Project". */
export function typeName(type: ActivityType, t: TFunction): string {
  return type === "project" ? t("activities.kind.project") : t(`eval.mode.${type}`);
}

export function bucketOf(state: EvaluationState | ProjectState): Bucket {
  return activityBucket(state);
}

/** Where a row sits on the gantt, in ms: from `s` to `d`. */
export interface Span {
  s: number;
  d: number;
}

/**
 * What one kind of activity answers, whatever the view asks — the client's
 * mirror of the server's `ActivityKind` (`modules/activity/`). A new kind is
 * one entry here; no view branches on `kind`.
 */
export interface ActivityKindSpec<A extends ActivitySummary> {
  /** Its type chip. */
  type(a: A): ActivityType;
  /** Its type as a row says it ("Exercise · take-home"). */
  typeLabel(a: A, t: TFunction): string;
  /**
   * The moment that places it in time. Null for an evaluation draft nobody
   * dated yet — the schedule files it under "Not scheduled".
   */
  anchor(a: A): string | null;
  /**
   * When it closes, if it does — or, once over, when it actually closed: an
   * exam ended early, a poll ended by hand, has no deadline worth showing.
   */
  closes(a: A): string | null;
  /** It was ended by a person, not by its clock: the list marks it. */
  closedByHand(a: A): boolean;
  /** On the "Live now" block. */
  live(a: A, now: number): boolean;
  /** Someone is in the room: the gantt's bar runs up to now, ringed green. */
  inRoom(a: A): boolean;
  /** Where it sits on the gantt; null for what has no date at all. */
  span(a: A, now: number): Span | null;
  /** Where a click on its row leads. */
  home(a: A): Route;
  stateLabel(a: A, t: TFunction): string;
  stateTone(a: A): Tone;
}

/** Its closing time, or once over the instant it actually closed. */
const evaluationCloses = (a: EvaluationActivitySummary): string | null =>
  bucketOf(a.state) === "ended" ? (a.closedAt ?? a.closesAt) : a.closesAt;

/**
 * An evaluation's span: from its opening (or its actual start) to its
 * closing; an OPEN one without a closing runs up to now, and one without any
 * date at all (an exam in its lobby) sits on now, so whatever is in the room
 * is always on the axis around the "now" line. An ended one stops where it
 * actually closed, failing that at its closing time, failing both at its
 * last change. A draft nobody dated has no place: null.
 */
function evaluationSpan(a: EvaluationActivitySummary, now: number): Span | null {
  const open = bucketOf(a.state) === "open";
  const start = a.opensAt ?? a.startedAt;
  if (start === null && !open) return null;
  const s = start === null ? now : new Date(start).getTime();
  const ended = bucketOf(a.state) === "ended";
  const close = evaluationCloses(a);
  const end =
    close !== null
      ? new Date(close).getTime()
      : open
        ? now
        : ended
          ? new Date(a.updatedAt).getTime()
          : s;
  return { s, d: Math.max(s, end) };
}

export const KIND: { [K in ActivitySummary["kind"]]: ActivityKindSpec<Extract<ActivitySummary, { kind: K }>> } = {
  evaluation: {
    type: (a) => a.mode,
    typeLabel: (a, t) => {
      const mode = typeName(a.mode, t);
      return a.takeHome ? `${mode} · ${t("activities.takeHome")}` : mode;
    },
    anchor: (a) => a.opensAt ?? a.startedAt ?? a.closesAt,
    closes: evaluationCloses,
    closedByHand: (a) => bucketOf(a.state) === "ended" && a.closedBy === "teacher",
    live: (a, now) => isLiveNow(a, now),
    inRoom: (a) => bucketOf(a.state) === "open",
    span: evaluationSpan,
    home: evaluationHome,
    stateLabel: (a, t) => evaluationStateLabel(a.state, t),
    stateTone: (a) => stateTone(a.state),
  },
  project: {
    type: () => "project",
    typeLabel: (_, t) => typeName("project", t),
    anchor: (a) => a.startAt,
    closes: (a) => a.deadlineAt,
    closedByHand: () => false,
    live: () => false,
    inRoom: () => false,
    // A project with no start (a draft published by hand) is undated, like a draft evaluation.
    span: (a) => {
      if (a.startAt === null) return null;
      const s = new Date(a.startAt).getTime();
      return { s, d: Math.max(s, a.deadlineAt === null ? s : new Date(a.deadlineAt).getTime()) };
    },
    // The project page (M3-12), in every build.
    home: (a) => ({ view: "project", id: a.id }),
    stateLabel: (a, t) => projectStateLabel(a.state, t),
    stateTone: (a) => projectStateTone(a.state),
  },
};

/**
 * The spec of a row's kind. The one cast of the table: TypeScript cannot tie
 * `KIND[a.kind]` back to `a` itself.
 */
export const kindOf = <A extends ActivitySummary>(a: A): ActivityKindSpec<A> =>
  KIND[a.kind] as unknown as ActivityKindSpec<A>;

export const typeOf = (a: ActivitySummary): ActivityType => kindOf(a).type(a);
export const anchorOf = (a: ActivitySummary): string | null => kindOf(a).anchor(a);
export const closesOf = (a: ActivitySummary): string | null => kindOf(a).closes(a);
export const closedByHand = (a: ActivitySummary): boolean => kindOf(a).closedByHand(a);
export const isLive = (a: ActivitySummary, now: number): boolean => kindOf(a).live(a, now);

const time = (iso: string | null) => (iso === null ? null : new Date(iso).getTime());

/**
 * The order nobody clicked for: what is open first, then what comes next
 * (the soonest first, the undated drafts last), then what is over (the most
 * recently closed first). It answers "what needs me" before "what happened".
 */
export function activityOrder(rows: readonly ActivitySummary[]): ActivitySummary[] {
  const rank: Record<Bucket, number> = { open: 0, upcoming: 1, ended: 2 };
  return [...rows].sort((a, b) => {
    const byBucket = rank[bucketOf(a.state)] - rank[bucketOf(b.state)];
    if (byBucket !== 0) return byBucket;
    const ended = bucketOf(a.state) === "ended";
    const key = (r: ActivitySummary) => time(ended ? (closesOf(r) ?? anchorOf(r)) : anchorOf(r));
    const [ta, tb] = [key(a), key(b)];
    if (ta === tb) return a.title.localeCompare(b.title);
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ended ? tb - ta : ta - tb;
  });
}

/** The type chips: an empty set filters nothing, no chip pressed is "every type". */
export function matchesType(a: ActivitySummary, types: ReadonlySet<ActivityType>): boolean {
  return types.size === 0 || types.has(typeOf(a));
}

// --- The schedule ------------------------------------------------------------

const DAY = 86_400_000;

/** Local midnight of the Monday of `t`'s week. */
export function mondayOf(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** ISO 8601 week number (weeks start on Monday, week 1 holds the first Thursday). */
export function isoWeek(t: number): number {
  const monday = mondayOf(t);
  // The Thursday of the week decides its year; week 1 holds 4 January.
  const year = new Date(monday + 3 * DAY).getFullYear();
  const first = mondayOf(new Date(year, 0, 4).getTime());
  // Rounded: a daylight-saving change makes one week an hour short or long.
  return 1 + Math.round((monday - first) / (7 * DAY));
}

export interface Week {
  /** Local midnight of its Monday; null for the undated rows. */
  start: number | null;
  rows: ActivitySummary[];
}

/**
 * Where the schedule files a row: an OPEN one is filed under now — it is
 * this week's business, whenever it opened (a two-week series opened last
 * Monday, an exam in its lobby with no date at all) — anything else under
 * {@link anchorOf}.
 */
export function scheduleAnchorOf(a: ActivitySummary, now: number): number | null {
  return bucketOf(a.state) === "open" ? now : time(anchorOf(a));
}

const shownTime = (a: ActivitySummary, now: number): number =>
  time(anchorOf(a)) ?? scheduleAnchorOf(a, now)!;

/**
 * The rows by the week of their schedule anchor, oldest week first, each
 * week in time order; the undated drafts last, in a week of their own.
 */
export function weeksOf(rows: readonly ActivitySummary[], now: number): Week[] {
  const byWeek = new Map<number, ActivitySummary[]>();
  const undated: ActivitySummary[] = [];
  for (const row of rows) {
    const anchor = scheduleAnchorOf(row, now);
    if (anchor === null) {
      undated.push(row);
      continue;
    }
    const start = mondayOf(anchor);
    byWeek.set(start, [...(byWeek.get(start) ?? []), row]);
  }
  const weeks: Week[] = [...byWeek.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, list]) => ({
      start,
      // Inside a week, by the time the row shows (an open series opened
      // last Monday leads this week); an undated lobby by now.
      rows: list.sort((a, b) => shownTime(a, now) - shownTime(b, now) || a.title.localeCompare(b.title)),
    }));
  if (undated.length > 0) {
    weeks.push({ start: null, rows: undated.sort((a, b) => a.title.localeCompare(b.title)) });
  }
  return weeks;
}

/**
 * A week the schedule may fold away: before this one, and holding nothing
 * but ended rows. A week with something open or still to come never folds —
 * it is exactly what the teacher must not lose behind a button.
 */
export function foldable(week: Week, now: number): boolean {
  return (
    week.start !== null &&
    week.start < mondayOf(now) &&
    week.rows.every((row) => bucketOf(row.state) === "ended")
  );
}

// --- The summary -------------------------------------------------------------

const WEEK_MS = 7 * 86_400_000;

/** The next thing that happens to a row: it opens, or it closes, at `at`. */
export interface NextEvent {
  row: ActivitySummary;
  at: string;
  what: "opens" | "closes";
}

/**
 * What the summary tiles above the tabs say, from the rows alone (the
 * students of what is open come from the server, `ActivityStats`):
 * - `open`: what runs now (the "open" age);
 * - `toRelease`: the evaluations closed or in grading, results not out — a
 *   poll stops at closed and is never released (ADR-014), so it is not one;
 * - `week`: the rows that open or close in the next seven days, and the
 *   first of those events;
 * - `projects`: the published projects and the nearest deadline; null where
 *   the teacher has no project at all, so the tile is not drawn.
 */
export interface ActivitiesSummary {
  open: number;
  toRelease: number;
  week: { count: number; next: NextEvent | null };
  projects: { count: number; next: NextEvent | null } | null;
}

/** Closed or in grading, results not released: the teacher's next task. */
export const awaitsRelease = (a: ActivitySummary): boolean =>
  a.kind === "evaluation" && a.mode !== "poll" && (a.state === "closed" || a.state === "grading");

/** What will happen to a row from `now` on: its opening if still ahead, its closing if it is not over. */
function eventsOf(a: ActivitySummary, now: number): NextEvent[] {
  if (tabOf(a) !== "current") return [];
  const events: NextEvent[] = [];
  const anchor = anchorOf(a);
  if (bucketOf(a.state) === "upcoming" && anchor !== null) events.push({ row: a, at: anchor, what: "opens" });
  const closes = closesOf(a);
  if (closes !== null) events.push({ row: a, at: closes, what: "closes" });
  return events.filter((e) => new Date(e.at).getTime() >= now);
}

const first = (events: NextEvent[]): NextEvent | null =>
  events.reduce<NextEvent | null>(
    (min, e) => (min === null || new Date(e.at).getTime() < new Date(min.at).getTime() ? e : min),
    null,
  );

export function summaryOf(rows: readonly ActivitySummary[], now: number): ActivitiesSummary {
  const soon = rows.flatMap((a) => eventsOf(a, now).filter((e) => new Date(e.at).getTime() < now + WEEK_MS));
  const projects = rows.filter((a) => a.kind === "project");
  const running = projects.filter((a) => bucketOf(a.state) === "open");
  return {
    open: rows.filter((a) => bucketOf(a.state) === "open").length,
    toRelease: rows.filter(awaitsRelease).length,
    week: { count: new Set(soon.map((e) => e.row.id)).size, next: first(soon) },
    projects:
      projects.length === 0
        ? null
        : {
            count: running.length,
            next: first(running.flatMap((a) => eventsOf(a, now).filter((e) => e.what === "closes"))),
          },
  };
}
