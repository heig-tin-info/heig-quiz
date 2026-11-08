/**
 * `deadlineFor` on plain rows — no database. The arithmetic is
 * `@quiz/domain`'s (`packages/domain/src/deadline.test.ts`); this pins what
 * the wrapper adds: the timing read from the settings, and the rounding of
 * the stored bonus alone.
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

describe("deadlineFor", () => {
  it("rounds the stored bonus, never the deadline", () => {
    const { deadlineAt, bonusS } = deadlineFor(row({ durationS: 1001 }), { timeBonusPercent: 7 }, START, 0);
    expect(bonusS).toBe(70);
    expect(deadlineAt).toEqual(new Date(START.getTime() + 1001_000 + 70_070));
  });

  it("reads the timing from the settings: deadline timing anchors on closesAt, whatever the start", () => {
    const evaluation = row({ settings: { timing: "deadline" }, opensAt: START, closesAt: at(3600) });
    expect(deadlineFor(evaluation, { timeBonusPercent: 10 }, at(1200), 60)).toEqual({
      deadlineAt: at(3600 + 360 + 60),
      bonusS: 360,
    });
  });
});
