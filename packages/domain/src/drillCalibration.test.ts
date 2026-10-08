import { describe, expect, it } from "vitest";

import {
  DRILL_CALIBRATION_MIN_N,
  DRILL_CONFIDENCE_MIN_STUDENTS,
  drillCalibration,
  drillCalibrationRate,
  drillConfidenceShown,
  drillConfidenceSplit,
  drillConfidentErrorShare,
  type DrillConfidenceCount,
} from "./drillCalibration.js";

const counts: DrillConfidenceCount[] = [
  { confidence: 3, correctness: "right", count: 5 },
  { confidence: 3, correctness: "wrong", count: 2 },
  { confidence: 3, correctness: "partial", count: 1 },
  { confidence: 0, correctness: "right", count: 1 },
  { confidence: 1, correctness: "wrong", count: 4 },
  { confidence: 4, correctness: "wrong", count: 3 },
];

describe("drillCalibration", () => {
  it("gives the five levels, lowest first, a level never stated at zero", () => {
    const levels = drillCalibration(counts);
    expect(levels.map((l) => l.confidence)).toEqual([0, 1, 2, 3, 4]);
    expect(levels[2]).toEqual({ confidence: 2, answers: 0, right: 0 });
  });

  it("counts a partial answer as an answer that is not right", () => {
    expect(drillCalibration(counts)[3]).toEqual({ confidence: 3, answers: 8, right: 5 });
  });

  it("is empty-handed for no reviews", () => {
    expect(drillCalibration([]).every((l) => l.answers === 0)).toBe(true);
  });
});

describe("drillCalibrationRate", () => {
  it("is the share right from the threshold on, and null below it", () => {
    expect(DRILL_CALIBRATION_MIN_N).toBe(5);
    expect(drillCalibrationRate({ answers: 8, right: 5 })).toBe(0.625);
    expect(drillCalibrationRate({ answers: 5, right: 0 })).toBe(0);
    expect(drillCalibrationRate({ answers: 4, right: 4 })).toBeNull();
    expect(drillCalibrationRate({ answers: 0, right: 0 })).toBeNull();
  });
});

describe("drillConfidenceSplit", () => {
  it("splits at Sure: 3 and 4 are sure, 0 to 2 unsure; a partial answer is left out", () => {
    expect(drillConfidenceSplit(counts)).toEqual({ rightSure: 5, rightUnsure: 1, wrongSure: 5, wrongUnsure: 4 });
  });

  it("counts Fairly sure as unsure", () => {
    expect(drillConfidenceSplit([{ confidence: 2, correctness: "wrong", count: 1 }]).wrongUnsure).toBe(1);
  });
});

describe("drillConfidentErrorShare", () => {
  it("is the confident errors among the wrong answers", () => {
    expect(drillConfidentErrorShare({ rightSure: 9, rightUnsure: 0, wrongSure: 3, wrongUnsure: 1 })).toBe(0.75);
  });

  it("is null without a wrong answer", () => {
    expect(drillConfidentErrorShare({ rightSure: 9, rightUnsure: 2, wrongSure: 0, wrongUnsure: 0 })).toBeNull();
  });
});

describe("drillConfidenceShown", () => {
  it("shows a question's split from ten distinct students, never below", () => {
    expect(DRILL_CONFIDENCE_MIN_STUDENTS).toBe(10);
    expect(drillConfidenceShown(9)).toBe(false);
    expect(drillConfidenceShown(10)).toBe(true);
  });
});
