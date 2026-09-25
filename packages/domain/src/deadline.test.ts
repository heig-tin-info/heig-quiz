import { describe, expect, it } from "vitest";
import {
  attemptDeadline,
  bonusSeconds,
  GRACE_MS,
  isWritable,
  previewDurationS,
  remainingSeconds,
} from "./deadline.js";

const startedAt = new Date("2026-09-20T08:00:00Z");
const opensAt = new Date("2026-09-20T08:00:00Z");
const closesAt = new Date("2026-09-20T09:00:00Z");

const duration = {
  timing: "duration",
  startedAt,
  durationS: 1800,
  opensAt: null,
  closesAt: null,
  timeBonusPercent: 0,
  extraS: 0,
} as const;

describe("bonusSeconds", () => {
  it("is zero without an accommodation", () => {
    expect(bonusSeconds(duration)).toBe(0);
  });

  it("is a percentage of the nominal duration in `duration` timing", () => {
    expect(bonusSeconds({ ...duration, timeBonusPercent: 33 })).toBe(594);
    expect(bonusSeconds({ ...duration, durationS: null, timeBonusPercent: 33 })).toBe(0);
  });

  it("is a percentage of the announced window in `deadline` timing (D8)", () => {
    const base = { timing: "deadline", durationS: null, opensAt, closesAt, timeBonusPercent: 50 } as const;
    expect(bonusSeconds(base)).toBe(1800);
    expect(bonusSeconds({ ...base, opensAt: null })).toBe(0);
    expect(bonusSeconds({ ...base, closesAt: null })).toBe(0);
    expect(bonusSeconds({ ...base, closesAt: opensAt })).toBe(0);
  });

  it("is zero in `manual` timing", () => {
    expect(bonusSeconds({ ...duration, timing: "manual", timeBonusPercent: 50 })).toBe(0);
  });
});

describe("attemptDeadline", () => {
  it("adds the duration to the start", () => {
    expect(attemptDeadline(duration)).toEqual(new Date("2026-09-20T08:30:00Z"));
  });

  it("adds the accommodation and the manual extensions", () => {
    // 30 min + 33 % = 39 min 54 s, plus a +5 min button.
    expect(attemptDeadline({ ...duration, timeBonusPercent: 33 })).toEqual(
      new Date("2026-09-20T08:39:54Z"),
    );
    expect(attemptDeadline({ ...duration, timeBonusPercent: 33, extraS: 300 })).toEqual(
      new Date("2026-09-20T08:44:54Z"),
    );
  });

  it("extends `closesAt` in `deadline` timing", () => {
    const base = {
      timing: "deadline",
      startedAt,
      durationS: null,
      opensAt,
      closesAt,
      timeBonusPercent: 50,
      extraS: 60,
    } as const;
    expect(attemptDeadline(base)).toEqual(new Date("2026-09-20T09:31:00Z"));
    expect(attemptDeadline({ ...base, closesAt: null })).toBeNull();
  });

  it("has no deadline in `manual` timing, nor without a duration", () => {
    expect(attemptDeadline({ ...duration, timing: "manual" })).toBeNull();
    expect(attemptDeadline({ ...duration, durationS: null })).toBeNull();
  });
});

describe("isWritable", () => {
  const deadline = new Date("2026-09-20T08:30:00Z");

  it("accepts a write up to and including deadline + GRACE_MS", () => {
    expect(GRACE_MS).toBe(3000);
    expect(isWritable(deadline, new Date(deadline.getTime() + 3000))).toBe(true);
    expect(isWritable(deadline, new Date(deadline.getTime() + 3001))).toBe(false);
    expect(isWritable(deadline, new Date(deadline.getTime() - 1))).toBe(true);
  });

  it("always accepts when there is no deadline", () => {
    expect(isWritable(null, new Date())).toBe(true);
  });
});

describe("remainingSeconds", () => {
  const deadline = new Date("2026-09-20T08:30:00Z");

  it("floors at zero and is null without a deadline", () => {
    expect(remainingSeconds(deadline, new Date("2026-09-20T08:29:00Z"))).toBe(60);
    expect(remainingSeconds(deadline, new Date("2026-09-20T08:31:00Z"))).toBe(0);
    expect(remainingSeconds(null, new Date())).toBeNull();
  });
});

describe("previewDurationS", () => {
  const none = { durationS: null, opensAt: null, closesAt: null };

  it("is the duration of a duration evaluation", () => {
    expect(previewDurationS({ ...none, timing: "duration", durationS: 1800 })).toBe(1800);
    expect(previewDurationS({ ...none, timing: "duration" })).toBeNull();
    expect(previewDurationS({ ...none, timing: "duration", durationS: 0 })).toBeNull();
  });

  it("is the announced window of a common-deadline evaluation", () => {
    expect(previewDurationS({ ...none, timing: "deadline", opensAt, closesAt })).toBe(3600);
    expect(previewDurationS({ ...none, timing: "deadline", closesAt })).toBeNull();
    // A window that closes before it opens has no clock to rehearse.
    expect(
      previewDurationS({ ...none, timing: "deadline", opensAt: closesAt, closesAt: opensAt }),
    ).toBeNull();
  });

  it("has no countdown in manual timing, whatever else is set", () => {
    expect(
      previewDurationS({ timing: "manual", durationS: 1800, opensAt, closesAt }),
    ).toBeNull();
  });
});
