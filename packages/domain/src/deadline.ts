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

export type EvaluationTiming = "duration" | "deadline" | "manual";

export interface BonusInput {
  timing: EvaluationTiming;
  /** Nominal duration in seconds, `duration` timing only. */
  durationS: number | null;
  opensAt: Date | null;
  closesAt: Date | null;
  /** Accommodation, in percent of the nominal duration (0 = none). */
  timeBonusPercent: number;
}

export interface DeadlineInput extends BonusInput {
  startedAt: Date;
  /** Manual extension already granted (the +1/+5/+10 buttons), in seconds. */
  extraS: number;
}

/**
 * The accommodation, in seconds.
 *
 * In `deadline` timing the base is the announced common window
 * `closesAt - opensAt` (decision D8), so two students with the same
 * accommodation get the same extension whatever time they started.
 */
export function bonusSeconds(input: BonusInput): number {
  if (input.timeBonusPercent <= 0) return 0;
  if (input.timing === "duration") {
    return input.durationS === null ? 0 : (input.durationS * input.timeBonusPercent) / 100;
  }
  if (input.timing === "deadline") {
    if (input.opensAt === null || input.closesAt === null) return 0;
    const windowS = (input.closesAt.getTime() - input.opensAt.getTime()) / 1000;
    return windowS <= 0 ? 0 : (windowS * input.timeBonusPercent) / 100;
  }
  return 0;
}

/**
 * The instant this attempt stops accepting writes, grace excluded.
 * `null` means "no deadline": `manual` timing, or a timing whose reference
 * instant is missing.
 */
export function attemptDeadline(input: DeadlineInput): Date | null {
  if (input.timing === "manual") return null;
  const extraMs = (bonusSeconds(input) + input.extraS) * 1000;
  if (input.timing === "duration") {
    if (input.durationS === null) return null;
    return new Date(input.startedAt.getTime() + input.durationS * 1000 + extraMs);
  }
  if (input.closesAt === null) return null;
  return new Date(input.closesAt.getTime() + extraMs);
}

/** The single acceptance rule, shared by the ticker and the autosave gate. */
export function isWritable(deadline: Date | null, now: Date): boolean {
  if (deadline === null) return true;
  return now.getTime() <= deadline.getTime() + GRACE_MS;
}

/** Seconds left before the deadline, floored at 0. `null` when there is no deadline. */
export function remainingSeconds(deadline: Date | null, now: Date): number | null {
  if (deadline === null) return null;
  return Math.max(0, (deadline.getTime() - now.getTime()) / 1000);
}
