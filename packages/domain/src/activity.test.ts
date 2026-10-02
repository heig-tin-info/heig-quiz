import { describe, expect, it } from "vitest";

import { activityBucket, isLiveNow, isTakeHome } from "./activity.js";

const NOW = new Date("2026-09-28T10:00:00Z");
const MIN = 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const row = (over: Partial<Parameters<typeof isLiveNow>[0]> = {}) => ({
  state: "running",
  takeHome: false,
  opensAt: null,
  updatedAt: NOW,
  ...over,
});

describe("isTakeHome", () => {
  it("is an exercise without a waiting room, nothing else", () => {
    expect(isTakeHome({ mode: "exercise", lobby: "skip" })).toBe(true);
    expect(isTakeHome({ mode: "exercise", lobby: "manual" })).toBe(false);
    expect(isTakeHome({ mode: "exercise", lobby: undefined })).toBe(false);
    expect(isTakeHome({ mode: "exam", lobby: "skip" })).toBe(false);
    expect(isTakeHome({ mode: "poll", lobby: "skip" })).toBe(false);
  });
});

describe("isLiveNow", () => {
  it("is live in the lobby, running or paused", () => {
    for (const state of ["lobby", "running", "paused"]) {
      expect(isLiveNow(row({ state }), NOW)).toBe(true);
    }
  });

  it("is not live at rest", () => {
    for (const state of ["draft", "closed", "grading", "released"]) {
      expect(isLiveNow(row({ state }), NOW)).toBe(false);
    }
  });

  it("is never live for a take-home exercise", () => {
    expect(isLiveNow(row({ takeHome: true }), NOW)).toBe(false);
  });

  it("forgets a session untouched for 12 hours", () => {
    expect(isLiveNow(row({ updatedAt: at(-11 * 60 * MIN) }), NOW)).toBe(true);
    expect(isLiveNow(row({ updatedAt: at(-13 * 60 * MIN) }), NOW)).toBe(false);
  });

  it("takes a scheduled one within 15 minutes of its opening, or just past it", () => {
    const scheduled = (opensAt: Date | null) => row({ state: "scheduled", opensAt });
    expect(isLiveNow(scheduled(at(10 * MIN)), NOW)).toBe(true);
    expect(isLiveNow(scheduled(at(20 * MIN)), NOW)).toBe(false);
    expect(isLiveNow(scheduled(at(-5 * MIN)), NOW)).toBe(true);
    expect(isLiveNow(scheduled(at(-13 * 60 * MIN)), NOW)).toBe(false);
    expect(isLiveNow(scheduled(null), NOW)).toBe(false);
  });

  it("reads ISO strings and epoch milliseconds alike", () => {
    expect(isLiveNow(row({ updatedAt: NOW.toISOString() }), NOW.getTime())).toBe(true);
  });
});

describe("activityBucket", () => {
  it("sorts both kinds' states into three ages", () => {
    expect((["draft", "scheduled"] as const).map(activityBucket)).toEqual(["upcoming", "upcoming"]);
    expect((["lobby", "running", "paused", "published"] as const).map(activityBucket)).toEqual([
      "open",
      "open",
      "open",
      "open",
    ]);
    expect((["closed", "grading", "released", "locked"] as const).map(activityBucket)).toEqual([
      "ended",
      "ended",
      "ended",
      "ended",
    ]);
  });
});
