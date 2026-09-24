/**
 * The cooldown of a program question's run buttons (docs/spec/04 §4.7).
 *
 * After each use, a button (Compile, Run the tests, Free try) refills before
 * it can be pressed again. The teacher picks one of two rules:
 *
 *  - `fixed`: always {@link COOLDOWN_BASE_MS};
 *  - `progressive`: {@link COOLDOWN_BASE_MS} × {@link COOLDOWN_GROWTH}^n,
 *    capped at {@link COOLDOWN_MAX_MS}, where `n` counts the recent uses. It
 *    slows down a student who clicks "run" instead of reading their code,
 *    and {@link decayedUses} gives the time back when they stop clicking.
 *
 * Pure: the caller keeps the count and the instant of the last use, and
 * passes the elapsed time in (no `Date.now()` here).
 */

/** The cooldown after a first use, and after every use under `fixed`. */
export const COOLDOWN_BASE_MS = 3000;
/** How much longer each further recent use makes the next wait, under `progressive`. */
export const COOLDOWN_GROWTH = 1.3;
/** The longest wait `progressive` ever imposes: a student is slowed, never locked out. */
export const COOLDOWN_MAX_MS = 30_000;
/**
 * The idle time that forgives one recent use. Twenty seconds is roughly what
 * it takes to read an output and change a line: a student who works between
 * runs drifts back to the base wait; one who clicks every few seconds climbs.
 */
export const COOLDOWN_DECAY_MS = 20_000;
/**
 * The slack added to the server floor. The server counts runs by their
 * RECEIPT time over a sliding minute, and two requests sent exactly
 * `60 s / budget` apart can arrive closer than that when the network jitters.
 */
export const COOLDOWN_SERVER_SLACK_MS = 500;

export type CooldownMode = "fixed" | "progressive";

/**
 * The wait after a use, before any floor.
 *
 * `uses` is the number of EARLIER recent uses, already decayed by
 * {@link decayedUses}: 0 for the first run of a session (3 s under both
 * modes), 1 for the second (3.9 s under `progressive`), and so on up to the
 * cap (reached after nine quick runs in a row: 3 s × 1.3⁹ ≈ 31.8 s). A negative or fractional
 * count is read as its non-negative floor.
 */
export function cooldownMs(mode: CooldownMode, uses: number): number {
  if (mode === "fixed") return COOLDOWN_BASE_MS;
  const n = Math.max(0, Math.floor(Number.isFinite(uses) ? uses : 0));
  return Math.min(COOLDOWN_MAX_MS, Math.round(COOLDOWN_BASE_MS * COOLDOWN_GROWTH ** n));
}

/**
 * The count of recent uses once idle time is forgiven: one use per full
 * {@link COOLDOWN_DECAY_MS} since the last one, never below zero. The idle
 * time runs from the last use itself, not from the end of its cooldown: that
 * is the rule a student can predict by looking at a clock.
 */
export function decayedUses(uses: number, idleMs: number): number {
  const n = Math.max(0, Math.floor(Number.isFinite(uses) ? uses : 0));
  const forgiven = Math.floor(Math.max(0, Number.isFinite(idleMs) ? idleMs : 0) / COOLDOWN_DECAY_MS);
  return Math.max(0, n - forgiven);
}

/**
 * The shortest wait a SERVER run may offer: the budget of N-SEC-07 allows
 * `runsPerMinute` runs per sliding minute, so a button that refills faster
 * than `60 s / runsPerMinute` would offer a click the server then refuses
 * with 429 — a button that lies. With the floor, the budget is never the
 * thing a student runs into by clicking as fast as the UI lets them.
 *
 * A BROWSER run costs the server nothing, so it has no floor (0): only the
 * teacher's rule applies.
 */
export function serverFloorMs(runsPerMinute: number): number {
  if (!Number.isFinite(runsPerMinute) || runsPerMinute <= 0) return COOLDOWN_MAX_MS;
  return Math.ceil(60_000 / runsPerMinute) + COOLDOWN_SERVER_SLACK_MS;
}

/** The wait a button actually shows: the teacher's rule, raised to the server floor when the run goes there. */
export function effectiveCooldownMs(options: {
  mode: CooldownMode;
  uses: number;
  onServer: boolean;
  runsPerMinute: number;
}): number {
  const own = cooldownMs(options.mode, options.uses);
  return options.onServer ? Math.max(own, serverFloorMs(options.runsPerMinute)) : own;
}
