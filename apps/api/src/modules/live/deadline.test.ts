/**
 * `deadlineFor`, the one computation of an attempt's deadline and bonus
 * (§10, decision D8), on plain rows — no database.
 */
import { describe, expect, it } from "vitest";

import type { EvaluationRecord } from "../evaluation/service.js";
import { deadlineFor } from "./deadline.js";

const START = new Date("2026-09-20T10:00:00.000Z");
const at = (s: number) => new Date(START.getTime() + s * 1000);

/** The fields the deadline reads: a 30-minute exam in `duration` timing. */
function row(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    id: "evaluation",
    settings: {},
    durationS: 1800,
    opensAt: null,
    closesAt: null,
    closesAtShiftS: 0,
    ...overrides,
  } as EvaluationRecord;
}

const seat = (timeBonusPercent: number) => ({ timeBonusPercent });

describe("deadlineFor in duration timing", () => {
  it("is the student's start plus the duration", () => {
    expect(deadlineFor(row(), seat(0), START, 0)).toEqual({ deadlineAt: at(1800), bonusS: 0 });
  });

  it("adds the accommodation on the duration and the attempt's own extra time", () => {
    expect(deadlineFor(row(), seat(25), START, 60)).toEqual({ deadlineAt: at(1800 + 450 + 60), bonusS: 450 });
  });

  it("cuts the nominal end at the window's close, then adds the bonus and the extra time", () => {
    const evaluation = row({ closesAt: at(900) });
    expect(deadlineFor(evaluation, seat(10), START, 30)).toEqual({ deadlineAt: at(900 + 180 + 30), bonusS: 180 });
  });

  it("rounds the stored bonus, never the deadline", () => {
    const { deadlineAt, bonusS } = deadlineFor(row({ durationS: 1001 }), seat(7), START, 0);
    expect(bonusS).toBe(70);
    expect(deadlineAt).toEqual(new Date(START.getTime() + 1001_000 + 70_070));
  });

  it("has no deadline without a duration", () => {
    expect(deadlineFor(row({ durationS: null }), seat(25), START, 0)).toEqual({ deadlineAt: null, bonusS: 0 });
  });
});

describe("deadlineFor in deadline timing", () => {
  const window = { settings: { timing: "deadline" }, opensAt: START, closesAt: at(3600) };

  it("anchors on closesAt whatever the start, the bonus on the announced window", () => {
    const evaluation = row(window);
    expect(deadlineFor(evaluation, seat(10), at(1200), 60)).toEqual({ deadlineAt: at(3600 + 360 + 60), bonusS: 360 });
  });

  it("takes the live shifts out of the bonus's base (D8, #253)", () => {
    const evaluation = row({ ...window, closesAt: at(4200), closesAtShiftS: 600 });
    expect(deadlineFor(evaluation, seat(10), START, 0)).toEqual({ deadlineAt: at(4200 + 360), bonusS: 360 });
  });
});

describe("deadlineFor in manual timing", () => {
  it("has no deadline without a safety deadline", () => {
    expect(deadlineFor(row({ settings: { timing: "manual" } }), seat(25), START, 0)).toEqual({
      deadlineAt: null,
      bonusS: 0,
    });
  });
});
