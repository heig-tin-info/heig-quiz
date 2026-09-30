/**
 * The pure half of the state machine (§5.1): the table of legal moves and
 * the guards, on plain rows — no database. What a route does with a refusal
 * (the 409 and its body) stays in `evaluation.db.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { EvaluationState } from "@quiz/contracts";

import { IllegalTransition, type EvaluationRecord } from "./shared.js";
import { assertReady, assertStaysScheduled, guardTransition, isLegalTransition, pastTimingOf } from "./stateMachine.js";

const NOW = new Date("2026-09-20T10:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

/** The fields the guards read, at the defaults of `seedLive`: a 30-minute exam in draft. */
function row(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    id: "evaluation",
    state: "draft",
    mode: "exam",
    settings: {},
    durationS: 1800,
    opensAt: null,
    closesAt: null,
    ...overrides,
  } as EvaluationRecord;
}

/** What readiness reads of an ordinary item list of two questions. */
const TWO_ITEMS = [
  { points: 1, bonus: false },
  { points: 1, bonus: false },
];
const ctx = (overrides: Partial<Parameters<typeof guardTransition>[2]> = {}) => ({
  items: TWO_ITEMS,
  attemptCount: 0,
  now: NOW,
  ...overrides,
});

/** The refusal `fn` throws: an {@link IllegalTransition} with these details. */
function refusal(fn: () => void, details: Record<string, unknown>) {
  expect(fn).toThrow(IllegalTransition);
  expect(fn).toThrow(expect.objectContaining({ code: "illegal_transition", status: 409, details }));
}

const OPENINGS = ["scheduled", "lobby", "running"] as const;

describe("the table of legal moves", () => {
  it.each([
    ["draft", "scheduled"],
    ["scheduled", "lobby"],
    ["lobby", "running"],
    ["running", "paused"],
    ["paused", "running"],
    ["running", "closed"],
    ["closed", "draft"],
    ["closed", "released"],
    ["released", "closed"],
  ] as const)("allows %s → %s", (from, to) => {
    expect(isLegalTransition(from, to)).toBe(true);
  });

  it.each([
    ["draft", "paused"],
    ["draft", "closed"],
    ["closed", "running"],
    ["released", "draft"],
  ] as const)("refuses %s → %s, through the guard too", (from, to) => {
    expect(isLegalTransition(from, to)).toBe(false);
    expect(() => guardTransition(row({ state: from }), to as EvaluationState, ctx())).toThrow(IllegalTransition);
  });
});

describe("readiness (assertReady)", () => {
  it("needs at least one question to open", () => {
    for (const to of OPENINGS) {
      refusal(() => assertReady(row({ opensAt: at(HOUR) }), to, []), { reason: "no_items" });
    }
    expect(() => assertReady(row(), "draft", [])).not.toThrow();
  });

  it("needs a question that counts towards the total (ADR-052)", () => {
    for (const items of [[{ points: 2, bonus: true }], [{ points: 0, bonus: false }]]) {
      refusal(() => assertReady(row(), "lobby", items), { reason: "no_graded_points" });
    }
  });

  it("refuses an exam whose timing says nothing (F-EVAL-04), not one with a common end", () => {
    refusal(() => assertReady(row({ durationS: null, opensAt: at(HOUR) }), "scheduled", TWO_ITEMS), {
      reason: "timing_incomplete",
      missing: ["durationS"],
    });
    const deadline = row({ durationS: null, settings: { timing: "deadline" }, opensAt: at(60_000), closesAt: at(HOUR) });
    expect(() => guardTransition(deadline, "scheduled", ctx())).not.toThrow();
  });

  it("names the missing opening time of a common-end exercise (#76)", () => {
    const exercise = row({
      mode: "exercise",
      durationS: null,
      settings: { timing: "deadline", lobby: "skip" },
      closesAt: at(7 * 24 * HOUR),
    });
    refusal(() => guardTransition(exercise, "lobby", ctx()), { reason: "timing_incomplete", missing: ["opensAt"] });
    expect(() => guardTransition({ ...exercise, opensAt: NOW }, "lobby", ctx())).not.toThrow();
  });

  it("refuses to schedule without an opening time (#152)", () => {
    refusal(() => guardTransition(row(), "scheduled", ctx()), { reason: "opens_at_missing" });
    expect(() => guardTransition(row({ opensAt: at(24 * HOUR) }), "scheduled", ctx())).not.toThrow();
  });
});

/*
 * #178: a time already past, by the server's clock. A common end reached
 * before the evaluation opens would close it at the ticker's next pass; a
 * schedule for a past instant would open it there. The instant itself is
 * past: `<=`, not `<`.
 */
describe("a time already past (#178)", () => {
  it("refuses to schedule or open once the common end has passed", () => {
    const passed = row({ durationS: null, settings: { timing: "deadline" }, opensAt: at(-HOUR), closesAt: NOW });
    for (const to of OPENINGS) {
      refusal(() => guardTransition(passed, to, ctx()), { reason: "closes_at_past" });
    }
    for (const to of ["lobby", "running"] as const) {
      expect(() => guardTransition(passed, to, ctx({ now: at(-1) }))).not.toThrow();
    }
    // A resume is not a start: it moves the common end by the pause itself.
    const paused = { ...passed, state: "paused" as const };
    expect(pastTimingOf(paused, "running", NOW)).toBeNull();
    expect(() => guardTransition(paused, "running", ctx())).not.toThrow();
  });

  it("refuses to schedule at an opening time already past", () => {
    const opensNow = row({ opensAt: NOW });
    refusal(() => guardTransition(opensNow, "scheduled", ctx()), { reason: "opens_at_past" });
    expect(() => guardTransition(opensNow, "scheduled", ctx({ now: at(-1) }))).not.toThrow();
  });
});

describe("the other guards", () => {
  it("refuses to pause anything but an exam", () => {
    expect(() => guardTransition(row({ state: "running" }), "paused", ctx())).not.toThrow();
    for (const mode of ["exercise", "poll"] as const) {
      expect(() => guardTransition(row({ state: "running", mode }), "paused", ctx())).toThrow(IllegalTransition);
    }
  });

  it("reopens a closed evaluation only while no attempt exists", () => {
    const closed = row({ state: "closed" });
    expect(() => guardTransition(closed, "draft", ctx())).not.toThrow();
    expect(() => guardTransition(closed, "draft", ctx({ attemptCount: 1 }))).toThrow(IllegalTransition);
  });
});

/*
 * What a patch of a scheduled evaluation must leave behind (#178, #254):
 * one the guard would still schedule. `evaluation.db.test.ts` shows the
 * PATCH route applying it to the merged row.
 */
describe("a scheduled evaluation stays schedulable (assertStaysScheduled)", () => {
  const deadline = row({
    state: "scheduled",
    durationS: null,
    settings: { timing: "deadline" },
    opensAt: at(HOUR),
    closesAt: at(2 * HOUR),
  });

  it("stays out of the past (#178)", () => {
    expect(() => assertStaysScheduled(deadline, NOW)).not.toThrow();
    refusal(() => assertStaysScheduled({ ...deadline, opensAt: NOW }, NOW), { reason: "opens_at_past" });
    refusal(() => assertStaysScheduled({ ...deadline, closesAt: NOW }, NOW), { reason: "closes_at_past" });
    expect(() => assertStaysScheduled({ ...deadline, opensAt: at(1) }, NOW)).not.toThrow();
  });

  it("keeps a complete timing when a time is cleared (#254)", () => {
    for (const field of ["opensAt", "closesAt"] as const) {
      refusal(() => assertStaysScheduled({ ...deadline, [field]: null }, NOW), {
        reason: "timing_incomplete",
        missing: [field],
      });
    }
    // Switching to a per-student timing without a duration is as incomplete.
    refusal(() => assertStaysScheduled({ ...deadline, settings: { timing: "duration" } }, NOW), {
      reason: "timing_incomplete",
      missing: ["durationS"],
    });

    // Per student, the opening time is what the ticker opens it at (#152).
    const duration = row({ state: "scheduled", opensAt: at(HOUR) });
    refusal(() => assertStaysScheduled({ ...duration, opensAt: null }, NOW), { reason: "opens_at_missing" });
    expect(() => assertStaysScheduled({ ...duration, closesAt: null }, NOW)).not.toThrow();
  });
});
