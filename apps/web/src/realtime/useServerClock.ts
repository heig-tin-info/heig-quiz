import { useCallback, useEffect, useRef, useState } from "react";

import { useNow } from "../ui";

import {
  applySample,
  initialClockState,
  toEpochMs,
  type ClockSample,
  type ClockState,
} from "./clock";

/**
 * The server clock as React state (docs/spec/05 §5.4, PLAN-MVP §4.8).
 *
 * Every surface that shows a deadline reads `now()` instead of `Date.now()`,
 * so a browser with a wrong system clock still counts down to the server's
 * deadline. Samples come from two places, both of which carry `serverNow`:
 * the `clock` SSE event (every 10 s, every second on a running attempt) and
 * the response of every autosave. The EventSource hook that will feed the
 * first one is owned by another work package; this hook only exposes the
 * `sample` entry point it will call.
 *
 * `offset` is state (a countdown must re-render when it moves), the window
 * behind it is a ref (its intermediate values are nobody's business). The
 * state is only replaced when the median actually changes, so a stream of
 * identical samples does not re-render every attached countdown.
 */
export interface ServerClock {
  /** Median offset in ms: `serverNow − clientNow`, corrected by half the RTT. */
  offset: number;
  /** The server's time as best the client knows it. */
  now: () => number;
  /** True once at least one sample has landed (until then `now()` is local). */
  synced: boolean;
  /**
   * Folds one `serverNow` in. `rttMs` is the measured round trip of the
   * request that carried it; leave it out for an SSE event, which is pushed
   * and has none.
   */
  sample: (serverNow: number | string, rttMs?: number) => void;
}

export function useServerClock(): ServerClock {
  const state = useRef<ClockState>(initialClockState);
  const [{ offset, synced }, setPublic] = useState({ offset: 0, synced: false });

  const sample = useCallback((serverNow: number | string, rttMs?: number) => {
    const next: ClockSample = {
      serverNow: toEpochMs(serverNow),
      clientNow: Date.now(),
      rttMs,
    };
    const applied = applySample(state.current, next);
    if (applied === state.current) return;
    state.current = applied;
    setPublic((prev) =>
      prev.offset === applied.offset && prev.synced ? prev : { offset: applied.offset, synced: true },
    );
  }, []);

  const now = useCallback(() => Date.now() + state.current.offset, []);

  return { offset, now, synced, sample };
}

/**
 * The server's "now" for a screen whose payload carries `serverNow` (the
 * student's home, classroom page and project, M3-13): the sample is folded
 * in as it lands, and the value ticks every 30 s. The offset is state, so a
 * sample that moves it re-renders at once rather than at the next tick.
 * Until a payload has landed (`undefined`), the local clock serves.
 */
export function useServerNow(serverNow: string | undefined): number {
  const clock = useServerClock();
  const { sample } = clock;
  useEffect(() => {
    if (serverNow !== undefined) sample(serverNow);
  }, [sample, serverNow]);
  return useNow(30_000) + clock.offset;
}
