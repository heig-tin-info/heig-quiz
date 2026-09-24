import { describe, expect, it } from "vitest";
import * as domain from "./index.js";

describe("@quiz/domain public surface", () => {
  it("exports every rule the plan names, plus the seeded shuffle from @quiz/core", () => {
    const expected = [
      "GRACE_MS",
      "assembleSource",
      "attemptDeadline",
      "clozeStudentTemplate",
      "compareOutput",
      "formatGrade",
      "formatPoints",
      "gradeCloze",
      "gradeFromPoints",
      "hashSeed",
      "mcqFraction",
      "missingTimingFields",
      "matchShortAnswer",
      "parseCloze",
      "parseRosterCsv",
      "pseudonym",
      "round2",
      "seededShuffle",
      "shuffle",
      "splitTemplate",
      "streamSeed",
    ];
    for (const name of expected) expect(domain).toHaveProperty(name);
  });
});
