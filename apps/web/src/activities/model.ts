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
import { isLiveNow } from "@quiz/domain";

import { evaluationHome, evaluationStateLabel, stateTone } from "../evaluation/common";
import type { TFunction } from "../i18n";
import { projectStateLabel, projectStateTone } from "../project/common";
import { routeEnabled, type Route } from "../router";
import type { Tone } from "../ui";

/** The three ages of an activity, as the state filter offers them. */
export type Bucket = "upcoming" | "open" | "ended";
export const BUCKETS: readonly Bucket[] = ["upcoming", "open", "ended"];

/** What the type chips filter on: an evaluation's mode, or "project". */
export type ActivityType = EvaluationMode | "project";
export const TYPES: readonly ActivityType[] = ["exam", "exercise", "poll", "project"];

/** A type chip's word: an evaluation's mode, or "Project". */
export function typeName(type: ActivityType, t: TFunction): string {
  return type === "project" ? t("activities.kind.project") : t(`eval.mode.${type}`);
}

/**
 * Both kinds' states, one table: a draft is a draft either way; a published
 * project is open (the students work in it — published by hand ahead of its
 * start, it is listed but not yet accepted, F-PROJ-04), a locked one is over.
 */
const BUCKET_OF: Record<EvaluationState | ProjectState, Bucket> = {
  draft: "upcoming",
  scheduled: "upcoming",
  lobby: "open",
  running: "open",
  paused: "open",
  published: "open",
  closed: "ended",
  grading: "ended",
  released: "ended",
  locked: "ended",
};

export function bucketOf(state: EvaluationState | ProjectState): Bucket {
  return BUCKET_OF[state];
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
  /** When it closes, if it does. */
  closes(a: A): string | null;
  /** On the "Live now" block. */
  live(a: A, now: number): boolean;
  /** Someone is in the room: the gantt's bar runs up to now, ringed green. */
  inRoom(a: A): boolean;
  /** Where it sits on the gantt; null for what has no date at all. */
  span(a: A, now: number): Span | null;
  /**
   * Where a click on its row leads; null where its page does not parse in
   * this build (`routeEnabled`): the row is then not clickable.
   */
  home(a: A): Route | null;
  stateLabel(a: A, t: TFunction): string;
  stateTone(a: A): Tone;
}

/**
 * An evaluation's span: from its opening (or its actual start) to its
 * closing; an OPEN one without a closing runs up to now, and one without any
 * date at all (an exam in its lobby) sits on now, so whatever is in the room
 * is always on the axis around the "now" line. An ended one without a closing
 * stops at its last change. A draft nobody dated has no place: null.
 */
function evaluationSpan(a: EvaluationActivitySummary, now: number): Span | null {
  const open = bucketOf(a.state) === "open";
  const start = a.opensAt ?? a.startedAt;
  if (start === null && !open) return null;
  const s = start === null ? now : new Date(start).getTime();
  const end =
    a.closesAt !== null
      ? new Date(a.closesAt).getTime()
      : open
        ? now
        : bucketOf(a.state) === "ended"
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
    closes: (a) => a.closesAt,
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
    live: () => false,
    inRoom: () => false,
    span: (a) => {
      const s = new Date(a.startAt).getTime();
      return { s, d: Math.max(s, new Date(a.deadlineAt).getTime()) };
    },
    // M3-12 drops `preview` from `project`, and the rows open.
    home: (a) => (routeEnabled("project") ? { view: "project", id: a.id } : null),
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
export const isLive = (a: ActivitySummary, now: number): boolean => kindOf(a).live(a, now);

const time = (iso: string | null) => (iso === null ? null : new Date(iso).getTime());

/**
 * The order nobody clicked for: what is open first, then what comes next
 * (the soonest first, the undated drafts last), then what is over (the most
 * recent first). It answers "what needs me" before "what happened".
 */
export function activityOrder(rows: readonly ActivitySummary[]): ActivitySummary[] {
  const rank: Record<Bucket, number> = { open: 0, upcoming: 1, ended: 2 };
  return [...rows].sort((a, b) => {
    const byBucket = rank[bucketOf(a.state)] - rank[bucketOf(b.state)];
    if (byBucket !== 0) return byBucket;
    const [ta, tb] = [time(anchorOf(a)), time(anchorOf(b))];
    if (ta === tb) return a.title.localeCompare(b.title);
    if (ta === null) return 1;
    if (tb === null) return -1;
    return bucketOf(a.state) === "ended" ? tb - ta : ta - tb;
  });
}

export interface Filters {
  types: ReadonlySet<ActivityType>;
  buckets: ReadonlySet<Bucket>;
}

/** An empty set filters nothing: no chip pressed is "everything". */
export function matches(a: ActivitySummary, f: Filters): boolean {
  return (
    (f.types.size === 0 || f.types.has(typeOf(a))) &&
    (f.buckets.size === 0 || f.buckets.has(bucketOf(a.state)))
  );
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
