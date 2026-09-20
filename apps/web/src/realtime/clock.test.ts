import { describe, expect, it } from "vitest";

import {
  applySample,
  initialClockState,
  medianOffset,
  pushOffset,
  SAMPLE_WINDOW,
  sampleOffset,
  toEpochMs,
} from "./clock";

/*
 * Synthetic skew: the "client" clock is deliberately wrong by a fixed amount
 * and the transport adds a round trip. The offset the client recovers must be
 * the skew, whatever the round trip, and one absurd sample must not move it.
 */

/** A sample as it would arrive on a client whose clock is `skew` ms behind. */
function arrive(serverNow: number, skew: number, rttMs: number) {
  return { serverNow, clientNow: serverNow - skew + rttMs / 2, rttMs };
}

describe("sampleOffset", () => {
  it("recovers the skew once half the round trip is given back", () => {
    expect(sampleOffset(arrive(1_000_000, 8_000, 400))).toBe(8_000);
  });

  it("is the raw difference when no round trip was measured (an SSE push)", () => {
    expect(sampleOffset({ serverNow: 1_000_500, clientNow: 1_000_000 })).toBe(500);
  });

  it("ignores a negative round trip rather than correcting the wrong way", () => {
    expect(sampleOffset({ serverNow: 1_000, clientNow: 900, rttMs: -400 })).toBe(100);
  });
});

describe("pushOffset", () => {
  it("keeps only the last five, oldest first", () => {
    let window: number[] = [];
    for (const v of [1, 2, 3, 4, 5, 6, 7]) window = pushOffset(window, v);
    expect(window).toEqual([3, 4, 5, 6, 7]);
    expect(window).toHaveLength(SAMPLE_WINDOW);
  });
});

describe("medianOffset", () => {
  it("is zero with no sample: the local clock is the honest fallback", () => {
    expect(medianOffset([])).toBe(0);
  });

  it("averages the two middle values on an even window", () => {
    expect(medianOffset([10, 20, 30, 40])).toBe(25);
  });

  it("does not move for one outlier, where a mean would", () => {
    const offsets = [5_000, 5_020, 4_980, 5_010, 60_000];
    expect(medianOffset(offsets)).toBe(5_010);
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    expect(Math.abs(mean - 5_000)).toBeGreaterThan(10_000);
  });
});

describe("applySample", () => {
  it("converges on the skew across five jittery round trips", () => {
    const skew = -37_000; // the browser's clock runs 37 s ahead of the server
    let state = initialClockState;
    for (const [i, rtt] of [120, 340, 80, 900, 200].entries()) {
      state = applySample(state, arrive(2_000_000 + i * 10_000, skew, rtt));
    }
    expect(state.samples).toBe(5);
    expect(state.offset).toBe(skew);
  });

  it("holds the median steady when one sample arrives absurdly late", () => {
    let state = initialClockState;
    for (let i = 0; i < 4; i += 1) state = applySample(state, arrive(1_000 + i, 2_500, 100));
    state = applySample(state, { serverNow: 1_000, clientNow: 1_000 - 2_500 - 45_000 });
    expect(state.offset).toBe(2_500);
  });

  it("drops a sample whose stamp could not be read", () => {
    const seeded = applySample(initialClockState, arrive(1_000, 700, 40));
    const after = applySample(seeded, { serverNow: Number.NaN, clientNow: 1_000 });
    expect(after).toBe(seeded);
  });
});

describe("toEpochMs", () => {
  it("reads both the ISO stamp of the SSE grammar and plain epoch ms", () => {
    expect(toEpochMs("2026-09-20T10:00:00.000Z")).toBe(Date.parse("2026-09-20T10:00:00.000Z"));
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(Number.isNaN(toEpochMs("not a date"))).toBe(true);
  });
});
