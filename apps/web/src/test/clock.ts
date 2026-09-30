import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

/*
 * A clock a test can jump instead of sitting through a delay (a debounce, a
 * settle time, a bound of several seconds).
 *
 * The timers are faked but keep flowing with the wall clock
 * (`shouldAdvanceTime`), so the stubbed fetches, the lazy chunks, React
 * Query's scheduling and Testing Library's `findBy*`/`waitFor` behave as with
 * real timers; only `elapse` moves time faster. Install it BEFORE the code
 * under test arms its timer: a timer armed on the real clock is not jumped,
 * and a test waiting for "nothing happened" would then pass without proving
 * anything. `setup.ts` restores the real timers after every test.
 */

/** Fakes the timers (flowing) and returns a `userEvent` that knows it. */
export function flowingClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

/** Moves the faked clock `ms` forward, inside `act`, running what falls due. */
export const elapse = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
