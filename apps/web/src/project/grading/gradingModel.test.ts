import { describe, expect, it } from "vitest";

import type { ProjectGradingRepo } from "@quiz/contracts";

import { gradingPrimary, nextToValidate } from "./gradingModel";

const repo = (id: string, over: Partial<ProjectGradingRepo> = {}, validation: Partial<ProjectGradingRepo["validation"]> = {}): ProjectGradingRepo => ({
  id,
  label: id,
  group: false,
  frozen: true,
  validation: { validated: false, missing: [], proposed: ["a"], ...validation },
  table: [],
  evidence: null,
  total: null,
  ...over,
});
const done = (id: string) => repo(id, {}, { validated: true, proposed: [] });

describe("the grading screen's primary action (ADR-106 §8)", () => {
  it("validates a repository whose criteria all have a row", () => {
    expect(gradingPrimary([repo("a", {}, { proposed: ["x", "y"] })], 0)).toEqual({ kind: "validate" });
  });

  it("holds Validate while a criterion has no row, or the repository is not frozen", () => {
    expect(gradingPrimary([repo("a", {}, { missing: ["git.commits"] })], 0)).toEqual({ kind: "blocked", reason: "missing" });
    expect(gradingPrimary([repo("a", { frozen: false })], 0)).toEqual({ kind: "blocked", reason: "notFrozen" });
  });

  it("goes on to the next repository to validate, wrapping around, then to the release once every one is frozen and validated", () => {
    expect(gradingPrimary([repo("a"), done("b"), done("c")], 2)).toEqual({ kind: "next", index: 0 });
    expect(gradingPrimary([done("a"), done("b")], 0)).toEqual({ kind: "release" });
    // An unfrozen repository is nothing to go to, and it holds the release.
    expect(nextToValidate([done("a"), repo("b", { frozen: false })], 0)).toBeNull();
    expect(gradingPrimary([done("a"), repo("b", { frozen: false })], 0)).toEqual({ kind: "blocked", reason: "notFrozen" });
    expect(nextToValidate([], 0)).toBeNull();
  });
});
