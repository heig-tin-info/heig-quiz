/**
 * A student's contestation of a graded unit (ADR-139): an exam's question
 * (F-GRADE-08), and — the same rule, unchanged — a project's criterion
 * (Lot 1b). One request, filed once with a mandatory reason, answered once
 * by the course owner: `accepted` or `refused`, never reopened, no thread.
 *
 * The window is a stored CLOSING INSTANT, set once at the first release
 * that opens one ({@link contestationClosesAt}) and moved only by the
 * owner's two acts, close now and extend ({@link windowExtendRefusal}).
 * Whether a unit may be contested is {@link unitRefusal} on the facts
 * {@link contestedUnit} builds, with the window ({@link contestationWindowOpen}):
 * the views read them to offer the control, the write decides the window
 * again on the database's clock (invariant 5).
 *
 * Pure: no clock is read here, every instant is the caller's.
 */

/** Where a contestation stands: filed and waiting, or answered for good. */
export const CONTESTATION_STATES = ["open", "accepted", "refused"] as const;
export type ContestationState = (typeof CONTESTATION_STATES)[number];

/** The owner's two answers. */
export const CONTESTATION_VERDICTS = ["accepted", "refused"] as const;
export type ContestationVerdict = (typeof CONTESTATION_VERDICTS)[number];

/** The longest reason or reply, in characters once trimmed: plain text, no Markdown. */
export const CONTESTATION_TEXT_MAX = 2000;

/** The window, in days after the release, of an evaluation that never chose one: on by default. */
export const CONTESTATION_DAYS_DEFAULT = 7;
/** The longest window a teacher may choose before the release; 0 is none. */
export const CONTESTATION_DAYS_MAX = 60;
/** How far ahead of now the owner may extend a window, in days. */
export const CONTESTATION_EXTEND_MAX_DAYS = 90;

const DAY_MS = 86_400_000;

/** The window of a feedback policy, in days: its `contestationDays`, absent {@link CONTESTATION_DAYS_DEFAULT}. */
export function contestationDaysOf(policy: { contestationDays?: number | undefined }): number {
  return policy.contestationDays ?? CONTESTATION_DAYS_DEFAULT;
}

/**
 * Whether a contestation window applies to an evaluation at all — the one
 * predicate the release (which opens one), the owner's acts (which move
 * it) and the staff's results (which offer them) read: an exam, released,
 * whose feedback policy shows results (`when` is not `none`). Never an
 * exercise nor a poll (decision 11).
 */
export function contestationWindowApplies(evaluation: { exam: boolean; released: boolean; when: string }): boolean {
  return evaluation.exam && evaluation.released && evaluation.when !== "none";
}

/**
 * The instant a window opened at `release` closes: `days` later, or none
 * when the teacher chose no window (0). Written once, by the release that
 * opens it; never recomputed from a later `released_at`. The contract
 * bounds the days.
 */
export function contestationClosesAt(release: Date, days: number): Date | null {
  return days === 0 ? null : new Date(release.getTime() + days * DAY_MS);
}

/** Whether the window holds at `now`: the unit's results are released, and the closing instant is still ahead. */
export function contestationWindowOpen(window: { released: boolean; closesAt: Date | null }, now: Date): boolean {
  return window.released && window.closesAt !== null && now.getTime() < window.closesAt.getTime();
}

/**
 * What a contested unit is, as the student's results show it. Generic on
 * purpose: an exam's cell (an attempt's answer to an item) and a project's
 * criterion (a repository's points on one criterion) read the same five facts.
 */
export interface ContestedUnit {
  /** The student's results page shows this unit's points (the feedback policy lets them through). */
  shown: boolean;
  /** The attempt (or repository) is the one that counts for the student. */
  counted: boolean;
  /** The unit counts somewhere: a neutralized question counts nowhere (ADR-108). */
  counting: boolean;
  /** A grading in force is validated: a pending one has nothing to contest yet. */
  graded: boolean;
  /** The validated points are the unit's maximum already. */
  full: boolean;
}

/**
 * The facts of a unit from its grading in force — the one builder the
 * write and the views both use, so a page never offers what the write
 * refuses. `grading`: the VALIDATED grading in force, its points and its
 * maximum; null while none is (pending).
 */
export function contestedUnit(facts: {
  shown: boolean;
  counted: boolean;
  counting: boolean;
  grading: { points: number; maxPoints: number } | null;
}): ContestedUnit {
  return {
    shown: facts.shown,
    counted: facts.counted,
    counting: facts.counting,
    graded: facts.grading !== null,
    full: facts.grading !== null && facts.grading.points >= facts.grading.maxPoints,
  };
}

/**
 * Why a unit may NOT be contested, or `null` when it may — the first
 * refusal, in this order: `not_shown`, `not_counted`, `not_counting`,
 * `pending`, `full_points`. The window is apart
 * ({@link contestationWindowOpen}): a view reads both, the write leaves the
 * window to the database's clock. An unanswered question is contestable
 * like any other: its zero is a grading.
 */
export const CONTEST_REFUSALS = ["not_shown", "not_counted", "not_counting", "pending", "full_points"] as const;
export type ContestRefusal = (typeof CONTEST_REFUSALS)[number];

export function unitRefusal(unit: ContestedUnit): ContestRefusal | null {
  if (!unit.shown) return "not_shown";
  if (!unit.counted) return "not_counted";
  if (!unit.counting) return "not_counting";
  if (!unit.graded) return "pending";
  if (unit.full) return "full_points";
  return null;
}

/**
 * Whether an answer explains itself enough: a refusal carries a reply, and
 * so does an acceptance that gives points, whose reply becomes the
 * override's comment; a bare acceptance may say nothing more. The one rule,
 * which the answer's contract refines with — an exam's question's and a
 * project's criterion's alike. Whether the contestation is still open is
 * the write's, under its conditional UPDATE.
 */
export function answerExplained(answer: { verdict: ContestationVerdict; reply: string; points: boolean }): boolean {
  return (answer.verdict === "accepted" && !answer.points) || answer.reply.trim() !== "";
}

/**
 * Why the owner may not extend a window to `closesAt`, or `null`: the new
 * instant lies ahead of `now` (`not_future`) and at most
 * {@link CONTESTATION_EXTEND_MAX_DAYS} days ahead (`too_far`). Extending may
 * reopen a closed window; closing is always allowed and sets it to now.
 */
export const WINDOW_EXTEND_REFUSALS = ["not_future", "too_far"] as const;
export type WindowExtendRefusal = (typeof WINDOW_EXTEND_REFUSALS)[number];

/** The latest instant the owner may extend a window to, at `now`. */
export function windowExtendLatest(now: Date): Date {
  return new Date(now.getTime() + CONTESTATION_EXTEND_MAX_DAYS * DAY_MS);
}

export function windowExtendRefusal(closesAt: Date, now: Date): WindowExtendRefusal | null {
  if (closesAt.getTime() <= now.getTime()) return "not_future";
  if (closesAt.getTime() > windowExtendLatest(now).getTime()) return "too_far";
  return null;
}
