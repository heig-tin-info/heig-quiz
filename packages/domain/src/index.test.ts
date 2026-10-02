import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import * as domain from "./index.js";

const SRC = dirname(fileURLToPath(import.meta.url));

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
      // Ported from heig-classroom (merge task M1-01).
      "checkpointDueAt",
      "extractScore",
      "groupRepoName",
      // The identity rule of the import and of login adoption (M1-06).
      "decideMatch",
      "parseStudentIgnore",
      "pickStudentRepo",
      // A project's score as a grade (M3-01, D05).
      "projectGrade",
      // What of a project may still change (M3-02, F-PROJ-03).
      "projectFieldRefusal",
      "editableProjectFields",
      "planCheckpointReviewDispatch",
      "planFinalReviewDispatch",
      "repoName",
      "resolveFinalScore",
      "runKind",
      "slugify",
      "zonedIso",
    ];
    for (const name of expected) expect(domain).toHaveProperty(name);
  });

  it("keeps the rules that pull a heavy dependency out of the index (ts-fsrs, mathjs)", () => {
    for (const name of ["reviewDrillCard", "draw", "validateParameters", "instantiate"]) {
      expect(domain).not.toHaveProperty(name);
    }
    // The vocabulary of parameterized questions is reachable without mathjs.
    for (const name of ["isVariableName", "FORMAT_PATTERN", "MAX_EXPRESSION_LENGTH", "referencedNames", "namesMentioned"]) {
      expect(domain).toHaveProperty(name);
    }
  });

  it("imports neither mathjs nor ts-fsrs anywhere in the index's import graph", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(join(SRC, file), "utf8");
      // Runtime imports only: an `import type` is erased from the bundle.
      for (const [, spec] of source.matchAll(/^(?:import|export)\s+(?!type\s)[^;]*?from\s+"([^"]+)"/gm)) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^(mathjs|ts-fsrs)(\/|$)/);
        if (spec!.startsWith("./") || spec!.startsWith("../")) visit(join(dirname(file), spec!.replace(/\.js$/, ".ts")));
      }
    };
    visit("index.ts");
    expect(seen).toContain("parameterNames.ts");
    expect(seen).not.toContain("parameters.ts");
  });
});
