/**
 * Attempt deadlines and the accommodation bonus (F-EVAL-05, F-ORG-07,
 * PLAN-MVP §7.4, decisions D8 and D12).
 *
 * The server owns the clock: `now` is always injected, never read here. The
 * ticker that closes an attempt and the autosave gate that accepts a write
 * must use the SAME rule, so `GRACE_MS` lives here once.
 */

/** A write arriving later than `deadline + GRACE_MS` is refused with 410 attempt_closed. */
export const GRACE_MS = 3000;

/** F-EVAL-04: who ends an attempt — its own duration, the common deadline, or the teacher. */
export const TIMINGS = ["duration", "deadline", "manual"] as const;
export type EvaluationTiming = (typeof TIMINGS)[number];

/**
 * The common window of a `deadline`-timed evaluation as the teacher set it.
 * `closesAt` is where the end stands NOW; `closesAtShiftS` is how far the live
 * controls (an extension to all, a resume after a pause) have moved it since
 * the teacher last set the timing (#253).
 */
export interface WindowInput {
  opensAt: Date | null;
  closesAt: Date | null;
  closesAtShiftS: number;
}

export interface BonusInput extends WindowInput {
  timing: EvaluationTiming;
  /** Nominal duration in seconds, `duration` timing only. */
  durationS: number | null;
  /** Accommodation, in percent of the nominal duration (0 = none). */
  timeBonusPercent: number;
}

export interface DeadlineInput extends BonusInput {
  startedAt: Date;
  /**
   * Time granted to this attempt on top of its anchor, in seconds: the
   * +1/+5/+10 buttons and the pauses it sat through. In `deadline` timing the
   * anchor is `closesAt`, so a shift common to everybody (an extension to all,
   * a pause) moves `closesAt` and is NEVER counted here as well (#252); only
   * what one student was given alone is. In `duration` timing there is no
   * common anchor, and every shift is counted here.
   */
  extraS: number;
}

/**
 * The ANNOUNCED window, in seconds: `closesAt - opensAt` as the teacher set
 * them, the live shifts taken back out (decision D8, #253). `null` when an
 * instant is missing or the window is empty or reversed.
 *
 * The announced window follows the teacher's own edits of the timing for as
 * long as the configuration is editable (draft, scheduled, a lobby nobody has
 * entered); it is frozen once it locks (F-EVAL-03: running, paused, or any
 * attempt). What the live controls add after that — "+N min" to everybody,
 * a pause — moves `closesAt` for everybody and never grows it: a student who
 * starts late, or whose attempt is reopened, gets the accommodation of the
 * window that was announced, not of the one the room ended up sitting.
 */
export function announcedWindowS(input: WindowInput): number | null {
  if (input.opensAt === null || input.closesAt === null) return null;
  const windowS = (input.closesAt.getTime() - input.opensAt.getTime()) / 1000 - input.closesAtShiftS;
  return windowS > 0 ? windowS : null;
}

/**
 * The accommodation, in seconds.
 *
 * In `deadline` timing the base is the announced common window
 * ({@link announcedWindowS}, decision D8), so two students with the same
 * accommodation get the same extension whatever time they started, and
 * whatever time was added to everybody since.
 */
export function bonusSeconds(input: BonusInput): number {
  if (input.timeBonusPercent <= 0) return 0;
  if (input.timing === "duration") {
    return input.durationS === null ? 0 : (input.durationS * input.timeBonusPercent) / 100;
  }
  if (input.timing === "deadline") {
    const windowS = announcedWindowS(input);
    return windowS === null ? 0 : (windowS * input.timeBonusPercent) / 100;
  }
  return 0;
}

/**
 * Whether the attempts hang off `closesAt` (ADR-086 §2): in `deadline`
 * timing it is the common end, in `manual` timing the optional safety
 * deadline. Time given to everybody (an extension to all, a pause) then
 * moves `closesAt` rather than each attempt's extra time (#252). In
 * `duration` timing every attempt has its own start, and `closesAt` is only
 * the end of the window that cuts it.
 */
export function anchoredOnClosesAt(timing: EvaluationTiming): boolean {
  return timing !== "duration";
}

/**
 * The instant this attempt stops accepting writes, grace excluded.
 * `null` means "no deadline": `manual` timing without a safety deadline, or
 * a timing whose reference instant is missing.
 *
 * - `duration`: the student's own start plus the duration, the accommodation
 *   and the extra time; with a `closesAt`, the nominal end is cut at the
 *   window's end even if time remains (ADR-086 §3), and the accommodation
 *   and the extra time are added after the cut: a student's extra time
 *   pushes the window's end for them, as in `deadline` timing.
 * - `deadline`: `closesAt` plus the accommodation and the extra time.
 * - `manual`: the safety deadline `closesAt` plus the extra time (ADR-086
 *   §2); no accommodation (`bonusSeconds` is 0), nothing nominal being
 *   announced.
 */
export function attemptDeadline(input: DeadlineInput): Date | null {
  const extraMs = (bonusSeconds(input) + input.extraS) * 1000;
  if (input.timing === "duration") {
    if (input.durationS === null) return null;
    const nominal = input.startedAt.getTime() + input.durationS * 1000;
    const cut = input.closesAt === null ? nominal : Math.min(nominal, input.closesAt.getTime());
    return new Date(cut + extraMs);
  }
  if (input.closesAt === null) return null;
  return new Date(input.closesAt.getTime() + extraMs);
}

/** The single acceptance rule, shared by the ticker and the autosave gate. */
export function isWritable(deadline: Date | null, now: Date): boolean {
  if (deadline === null) return true;
  return now.getTime() <= deadline.getTime() + GRACE_MS;
}

/**
 * How long a teacher's stateless preview of an evaluation lasts, in seconds
 * (issue #75, ADR-018 fourth addendum). `null` means no countdown.
 *
 * The preview starts when the teacher presses the button, so a `duration`
 * evaluation gives its duration and a `deadline` one gives its announced
 * window ({@link announcedWindowS}) — the time a student who starts at the
 * opening has (decision D8's base). A `manual` evaluation has no clock to rehearse,
 * and neither has a timing whose reference instants are missing or reversed.
 * No accommodation applies: the teacher has none.
 */
export function previewDurationS(
  input: WindowInput & { timing: EvaluationTiming; durationS: number | null },
): number | null {
  if (input.timing === "duration") {
    return input.durationS !== null && input.durationS > 0 ? input.durationS : null;
  }
  if (input.timing === "deadline") {
    const windowS = announcedWindowS(input);
    return windowS === null ? null : Math.round(windowS);
  }
  return null;
}
