/**
 * The student's view of a grading breakdown (`filterDetails`, docs/05 §5.7):
 * a pure function of the type, the details and the feedback policy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";
import type { CodeDetails } from "@quiz/qt-code/server";
import { registerForTests } from "@quiz/registry/server";

import { fakeShort } from "../../test/fakeType.js";
import * as service from "./service.js";

let restore: () => void;
beforeAll(() => {
  restore = registerForTests(fakeShort);
});
afterAll(() => restore());

/**
 * Layer 2 of the details filter alone: the fake `short` registered here has
 * no `studentDetails` hook, which is exactly the type that "gains a
 * key-bearing field and forgets the hook" the blind strip exists for (H1).
 */
describe("the blind strip of `details` (layer 2, H1)", () => {
  const leaky = {
    correct: [2],
    fraction: 0.5,
    perBlank: [{ index: 0, ok: false, given: "Lyon", expected: "Paris" }],
    cases: [
      { name: "shown", visible: true, expected: "shown-output" },
      { name: "hidden", visible: false, expected: "hidden-output" },
    ],
    nested: { deeper: { matchers: ["m"], pattern: "p+", referenceSolution: "int main" } },
    // Not key-bearing in a grading breakdown: a teacher's manual `details`
    // may carry any of these, and the strip leaves them alone.
    explanation: "why",
    answers: ["a"],
  };
  const policy = (showKey: boolean) => ({
    when: "on_release" as const,
    showAnswer: true,
    showKey,
    showExplanation: false,
    showHiddenCaseNames: false,
    showTeacherComment: true,
  });

  it("removes the forbidden keys at every depth, except the expected output of a visible case", () => {
    expect(service.filterDetails("short", leaky, policy(false))).toEqual({
      fraction: 0.5,
      perBlank: [{ index: 0, ok: false, given: "Lyon" }],
      cases: [
        { name: "shown", visible: true, expected: "shown-output" },
        { name: "hidden", visible: false },
      ],
      nested: { deeper: {} },
      explanation: "why",
      answers: ["a"],
    });
  });

  it("lets the details through whole when the teacher published the key", () => {
    expect(service.filterDetails("short", leaky, policy(true))).toEqual(leaky);
  });

  it("strips an LLM's reply under every policy, the published key included (ADR-045, ADR-063)", () => {
    const withReply = {
      ...leaky,
      justification: "why, for the teacher",
      ai: { model: "claude-sonnet-5-5", criteria: [{ criterion: "Rubric line", points: 1, maxPoints: 2, comment: "half" }] },
    };
    for (const showKey of [false, true]) {
      const filtered = service.filterDetails("short", withReply, policy(showKey));
      expect(filtered).not.toHaveProperty("justification");
      expect(filtered).not.toHaveProperty("ai");
      expect(JSON.stringify(filtered)).not.toContain("Rubric line");
    }
  });

  it("strips nothing but a breakdown's key fields: its own list, not the question-payload one", () => {
    // Every entry but `expected` is also a key of the common student floor;
    // `expected` is not (a visible code case publishes it, deviation W3-4).
    const common = new Set(COMMON_FORBIDDEN_STUDENT_KEYS);
    expect(service.FORBIDDEN_DETAIL_KEYS.filter((k) => !common.has(k))).toEqual(["expected"]);
  });
});

describe("the details filter for `code` (decision D15, deviation W3-5)", () => {
  const details: CodeDetails = {
    runner: "ok",
    compile: { ok: true, stderr: "", ms: 1 },
    cases: [
      {
        name: "visible-1",
        visible: true,
        points: 1,
        ok: true,
        exitCode: 0,
        ms: 1,
        timedOut: false,
        oom: false,
        expected: "42",
        actual: "42",
      },
      {
        name: "hidden-overflow",
        visible: false,
        points: 1,
        ok: false,
        exitCode: 1,
        ms: 2,
        timedOut: false,
        oom: false,
        expected: "SECRET-EXPECTED",
        actual: "SECRET-ACTUAL",
        stderr: "SECRET-STDERR",
      },
    ],
    earned: 1,
    total: 2,
    sourceSha256: "a".repeat(64),
  };

  const policy = (over: Partial<Record<string, boolean | string>> = {}) => ({
    when: "on_release" as const,
    showAnswer: true,
    showKey: false,
    showExplanation: false,
    showHiddenCaseNames: false,
    showTeacherComment: true,
    ...over,
  });

  it("strips the hidden case bodies and the name when the policy says so", () => {
    const filtered = service.filterDetails("code", details, policy());
    const json = JSON.stringify(filtered);
    expect(json).not.toContain("SECRET-EXPECTED");
    expect(json).not.toContain("SECRET-ACTUAL");
    expect(json).not.toContain("SECRET-STDERR");
    expect(json).not.toContain("hidden-overflow");
    // The verdict and the points survive: the student must still be able to
    // reason about the scale (decision D15).
    expect(json).toContain('"ok":false');
    expect(json).toContain("visible-1");
  });

  it("reduces a hidden case to its verdict, exit code and time included (ADR-096)", () => {
    for (const showHiddenCaseNames of [false, true]) {
      const filtered = service.filterDetails("code", details, policy({ showHiddenCaseNames })) as CodeDetails;
      expect(filtered.cases[1]).toEqual({
        name: showHiddenCaseNames ? "hidden-overflow" : "#2",
        visible: false,
        points: 1,
        ok: false,
        failure: "failed",
      });
      // The visible case is untouched (its expected output is published).
      expect(filtered.cases[0]).toEqual(details.cases[0]);
    }
  });

  it("keeps the hidden NAMES when `showHiddenCaseNames` is on", () => {
    const named = JSON.stringify(
      service.filterDetails("code", details, policy({ showHiddenCaseNames: true })),
    );
    expect(named).toContain("hidden-overflow");
    expect(named).not.toContain("SECRET-EXPECTED");
  });

  it("publishes everything when the teacher published the key", () => {
    const whole = JSON.stringify(
      service.filterDetails("code", details, policy({ showKey: true })),
    );
    expect(whole).toContain("SECRET-EXPECTED");
  });
});
