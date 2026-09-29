import { describe, expect, it } from "vitest";
import * as domain from "./index.js";

describe("@quiz/domain public surface", () => {
  it("exports every rule the plan names, plus the seeded shuffle from @quiz/core", () => {
    const expected = [
      "GRACE_MS",
      "isLiveNow",
      "isTakeHome",
      "allowedFeedbackWhen",
      "assembleSource",
      "announcedWindowS",
      "attemptDeadline",
      "clozeStudentTemplate",
      "compareOutput",
      "cooldownMs",
      "composeDrillSession",
      "isDrillEligible",
      "drillRating",
      "drillReferenceMs",
      "currentOrNextSemester",
      "formatGrade",
      "formatPoints",
      "gradeCloze",
      "gradeFromPoints",
      "hashSeed",
      "isCurrent",
      "keptAttempt",
      "mcqFraction",
      "missingTimingFields",
      "matchShortAnswer",
      "parseCloze",
      "parseRosterCsv",
      "pollOutcome",
      "previewDurationS",
      "pseudonym",
      "retakeRefusal",
      "round2",
      "shiftSemester",
      "shuffle",
      "splitTemplate",
      "streamSeed",
    ];
    for (const name of expected) expect(domain).toHaveProperty(name);
  });
});
