import { describe, expect, it } from "vitest";

import {
  keptAttempt,
  latestAttempt,
  retakeRefusal,
  retakesAllowedFor,
  retakesOn,
  type RetakeInput,
  type ScoredAttempt,
} from "./retake.js";

const now = new Date("2026-09-25T10:00:00Z");

const base: RetakeInput = {
  mode: "exercise",
  retakes: { enabled: true, keep: "best", maxAttempts: null },
  evaluationState: "running",
  closesAt: null,
  now,
  attempts: [{ attemptNumber: 1, state: "submitted" }],
};

describe("retakesAllowedFor / retakesOn (F-EVAL-15)", () => {
  it("allows the setting on an exercise only", () => {
    expect(retakesAllowedFor("exercise")).toBe(true);
    expect(retakesAllowedFor("exam")).toBe(false);
    expect(retakesAllowedFor("poll")).toBe(false);
  });

  it("is off when the switch is off, and on an exam whatever the switch says", () => {
    expect(retakesOn("exercise", { ...base.retakes, enabled: false })).toBe(false);
    expect(retakesOn("exam", base.retakes)).toBe(false);
    expect(retakesOn("exercise", base.retakes)).toBe(true);
  });
});

describe("retakeRefusal", () => {
  it("allows a retake once the previous attempt is finished", () => {
    expect(retakeRefusal(base)).toBeNull();
    expect(retakeRefusal({ ...base, attempts: [{ attemptNumber: 1, state: "expired" }] })).toBeNull();
  });

  it("refuses an exam and an exercise with the setting off", () => {
    expect(retakeRefusal({ ...base, mode: "exam" })).toBe("not_allowed");
    expect(retakeRefusal({ ...base, retakes: { ...base.retakes, enabled: false } })).toBe(
      "not_allowed",
    );
  });

  it("refuses outside a running evaluation", () => {
    for (const state of ["draft", "scheduled", "lobby", "paused", "closed", "grading", "released"] as const) {
      expect(retakeRefusal({ ...base, evaluationState: state }), state).toBe("not_open");
    }
  });

  it("refuses at and after the common end, before the ticker closes", () => {
    expect(retakeRefusal({ ...base, closesAt: new Date(now.getTime() + 1000) })).toBeNull();
    expect(retakeRefusal({ ...base, closesAt: now })).toBe("closed");
    expect(retakeRefusal({ ...base, closesAt: new Date(now.getTime() - 1000) })).toBe("closed");
  });

  it("refuses without a first attempt, and beside an open one", () => {
    expect(retakeRefusal({ ...base, attempts: [] })).toBe("no_attempt");
    expect(
      retakeRefusal({
        ...base,
        attempts: [
          { attemptNumber: 1, state: "submitted" },
          { attemptNumber: 2, state: "in_progress" },
        ],
      }),
    ).toBe("unfinished");
    expect(retakeRefusal({ ...base, attempts: [{ attemptNumber: 1, state: "not_started" }] })).toBe(
      "unfinished",
    );
  });

  it("refuses once the maximum is reached, and never with no maximum", () => {
    const two = [
      { attemptNumber: 1, state: "submitted" as const },
      { attemptNumber: 2, state: "expired" as const },
    ];
    expect(retakeRefusal({ ...base, retakes: { ...base.retakes, maxAttempts: 3 }, attempts: two })).toBeNull();
    expect(retakeRefusal({ ...base, retakes: { ...base.retakes, maxAttempts: 2 }, attempts: two })).toBe(
      "max_attempts",
    );
    const many = Array.from({ length: 40 }, (_, i) => ({
      attemptNumber: i + 1,
      state: "submitted" as const,
    }));
    expect(retakeRefusal({ ...base, attempts: many })).toBeNull();
  });
});

describe("latestAttempt", () => {
  it("is the highest number, whatever the order", () => {
    expect(latestAttempt([{ attemptNumber: 2 }, { attemptNumber: 3 }, { attemptNumber: 1 }])).toEqual({
      attemptNumber: 3,
    });
    expect(latestAttempt([])).toBeNull();
  });
});

describe("keptAttempt (F-EVAL-15)", () => {
  const a = (attemptNumber: number, points: number, state: ScoredAttempt["state"] = "submitted") => ({
    attemptNumber,
    points,
    state,
  });

  it("keeps the best score, a tie going to the latest", () => {
    expect(keptAttempt([a(1, 4), a(2, 7), a(3, 5)], "best")?.attemptNumber).toBe(2);
    expect(keptAttempt([a(1, 7), a(2, 7), a(3, 5)], "best")?.attemptNumber).toBe(2);
  });

  it("keeps the last finished attempt", () => {
    expect(keptAttempt([a(1, 9), a(2, 3)], "last")?.attemptNumber).toBe(2);
  });

  it("ignores an attempt still being written", () => {
    expect(keptAttempt([a(1, 4), a(2, 0, "in_progress")], "last")?.attemptNumber).toBe(1);
    expect(keptAttempt([a(1, 4), a(2, 9, "in_progress")], "best")?.attemptNumber).toBe(1);
  });

  it("falls back to the latest attempt when none is finished, and to null for none", () => {
    expect(keptAttempt([a(1, 0, "in_progress")], "best")?.attemptNumber).toBe(1);
    expect(keptAttempt([], "last")).toBeNull();
  });

  it("is the only attempt of a student who took one", () => {
    expect(keptAttempt([a(1, 2, "expired")], "best")?.attemptNumber).toBe(1);
    expect(keptAttempt([a(1, 2, "expired")], "last")?.attemptNumber).toBe(1);
  });
});
