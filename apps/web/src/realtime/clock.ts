/*
 * Server clock, the pure part (docs/spec/05 §5.4 "Horloge", PLAN-MVP §4.8).
 *
 * The server owns the clock (CLAUDE.md invariant 5): a deadline is the
 * server's, and a browser whose system time is ten minutes off must still see
 * the right countdown. Every `clock` SSE event and every autosave response
 * carries `serverNow`, which gives one sample of the offset between the two
 * clocks. A single sample is noisy — it is worth exactly the round trip that
 * carried it — so the client keeps the median of the last five, each one
 * corrected by half of its measured round trip.
 *
 * Median and not mean: one sample delayed by a garbage collection or a Wi-Fi
 * retry would drag a mean by seconds, and a countdown that jumps is worse
 * than one that lags.
 */

/** How many offsets the median is taken over (docs/05 §5.4: "les cinq derniers"). */
export const SAMPLE_WINDOW = 5;

export interface ClockSample {
  /** The server's own time, as it stamped the response or the event. */
  serverNow: number;
  /**
   * The client's time when that stamp ARRIVED (not when the request left).
   * The correction below assumes this reading, so the two must not drift.
   */
  clientNow: number;
  /**
   * Measured round trip of the request that carried the stamp, in ms. An SSE
   * event is pushed, not answered, so it has none: 0 then, which simply means
   * "no correction available".
   */
  rttMs?: number;
}

/**
 * Offset of one sample: how much to add to `Date.now()` to read the server's
 * clock. The stamp was written about half a round trip before it arrived, so
 * the server had already moved on by `rtt / 2` when the client read it.
 */
export function sampleOffset({ serverNow, clientNow, rttMs = 0 }: ClockSample): number {
  return serverNow + Math.max(0, rttMs) / 2 - clientNow;
}

/** The last `window` offsets, oldest first, with `offset` appended. */
export function pushOffset(
  offsets: readonly number[],
  offset: number,
  window = SAMPLE_WINDOW,
): number[] {
  const next = [...offsets, offset];
  return next.length > window ? next.slice(next.length - window) : next;
}

/**
 * Median of the offsets kept. An even count averages the two middle values,
 * so four samples do not favour the older one. An empty window means "no
 * sample yet": the offset is zero and the countdown runs on the local clock,
 * which is the honest fallback until the first event lands.
 */
export function medianOffset(offsets: readonly number[]): number {
  if (offsets.length === 0) return 0;
  const sorted = [...offsets].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Both shapes a `serverNow` arrives in: the SSE grammar and the autosave
 * response serialize it as an ISO string (`z.iso.datetime()`), while a test
 * or a replayed snapshot may hold epoch milliseconds. An unparsable value
 * yields NaN, and `applySample` drops it rather than poisoning the window.
 */
export function toEpochMs(serverNow: number | string): number {
  return typeof serverNow === "number" ? serverNow : Date.parse(serverNow);
}

export interface ClockState {
  /** The window of raw offsets, oldest first. */
  offsets: number[];
  /** Median of that window: what `now()` adds to `Date.now()`. */
  offset: number;
  /** How many samples have been folded in (0 = still on the local clock). */
  samples: number;
}

export const initialClockState: ClockState = { offsets: [], offset: 0, samples: 0 };

/**
 * Folds one sample into the state. A sample whose stamp could not be read is
 * ignored: a malformed event must not move a countdown a student is watching.
 */
export function applySample(state: ClockState, sample: ClockSample): ClockState {
  const offset = sampleOffset(sample);
  if (!Number.isFinite(offset)) return state;
  const offsets = pushOffset(state.offsets, offset);
  return { offsets, offset: medianOffset(offsets), samples: state.samples + 1 };
}
