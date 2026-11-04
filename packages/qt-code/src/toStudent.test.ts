/**
 * The type-specific half of the leak test (PLAN-MVP §2.5, docs/spec/05 §5.7,
 * invariant 4). The generic half — the full fixture of `./testing.ts`
 * searched for every forbidden key and secret value, and parsed by the
 * student schema — is the registry's contract test, for every type at once.
 */
import { describe, expect, it } from "vitest";

import { findStudentLeaks } from "@quiz/core/testing";

import { CodeConfig, type CodeReviewDetails } from "./schema.js";
import { codeServer, finalizeRunnerCode } from "./server.js";
import {
  codeConfig,
  codeLeakFixture,
  COMPILE_ARGS,
  FILE_CONTENT,
  FINALIZE_CTX,
  outcome,
  SECRET_HIDDEN_ARG,
  SECRET_HIDDEN_EXPECTED,
  SECRET_HIDDEN_NAME,
  SECRET_HIDDEN_STDIN,
  SECRET_REFERENCE,
} from "./test/fixtures.js";

const view = { seed: 7, itemId: "item-1", shuffle: true };

describe("codeServer.toStudent", () => {
  const student = codeServer.toStudent(codeConfig(), view);
  const serialized = JSON.stringify(student);

  it("publishes the visible cases and only counts the hidden ones", () => {
    expect(student.visibleCases.map((c) => c.name)).toEqual(["three items", "empty array"]);
    expect(student.visibleCases[0]).toEqual({
      name: "three items",
      args: [],
      stdin: "3\n1 2 3\n",
      expected: "6\n",
      compareStdout: true,
      expectedExitCode: 0,
      points: 1,
    });
    expect(student.hiddenCount).toBe(1);
    expect(student.hiddenPoints).toBe(2);
  });

  it("publishes the command line and the two checks of a VISIBLE case", () => {
    // A visible case is meant to be reproduced by the student, command line
    // included; the player shows "argv / stdin / expected / got".
    const config = CodeConfig.parse({
      ...codeConfig(),
      tests: {
        mode: "io",
        cases: [
          { name: "argv", args: ["3", "4"], expected: "7\n", visible: true, points: 1 },
          {
            name: "exit only",
            args: ["bad input"],
            expected: "ignored",
            compareStdout: false,
            expectedExitCode: 2,
            visible: true,
            points: 1,
          },
        ],
      },
    });
    const view = codeServer.toStudent(config, { seed: 1, itemId: "i", shuffle: false });
    expect(view.visibleCases[0]).toMatchObject({
      args: ["3", "4"],
      compareStdout: true,
      expectedExitCode: 0,
      expected: "7\n",
    });
    // Nothing compares stdout here, so there is no expected output to publish.
    expect(view.visibleCases[1]).toMatchObject({
      args: ["bad input"],
      compareStdout: false,
      expectedExitCode: 2,
      expected: "",
    });
    expect(JSON.stringify(view)).not.toContain("ignored");
  });

  it("publishes HOW outputs are compared, never WHAT they are (audit R-06)", () => {
    // `compare` left the shared floor for this one type: the player judges a
    // visible case with the grade's own options, so it must have them. The
    // shape is pinned — two switches and a tolerance, no string that could
    // carry an answer — and the secret-value search above still runs on the
    // whole payload.
    expect(student.compare).toEqual({ trimTrailing: true, ignoreCase: false, numeric: null });
    const tolerant = CodeConfig.parse({
      ...codeConfig(),
      tests: {
        ...codeConfig().tests,
        compare: { trimTrailing: false, ignoreCase: true, numeric: { epsilon: 0.001, mode: "rel" } },
      },
    });
    const published = codeServer.toStudent(tolerant, view);
    expect(published.compare).toEqual({
      trimTrailing: false,
      ignoreCase: true,
      numeric: { epsilon: 0.001, mode: "rel" },
    });
    expect(Object.keys(published.compare).sort()).toEqual(["ignoreCase", "numeric", "trimTrailing"]);
    expect(findStudentLeaks(published, codeLeakFixture)).toEqual([]);
  });

  it("passes the cooldown rule through, a UI pace and nothing of the key", () => {
    expect(student.cooldown).toBe("progressive");
    const fixed = CodeConfig.parse({ ...codeConfig(), cooldown: "fixed" });
    expect(codeServer.toStudent(fixed, view).cooldown).toBe("fixed");
  });

  it("says where the Run button executes, which the key never depends on", () => {
    expect(student.runtime).toBe("backend");
    const runno = CodeConfig.parse({ ...codeConfig(), runtime: "runno" });
    expect(codeServer.toStudent(runno, view).runtime).toBe("runno");
  });

  it("publishes the extra files whole and the compiler flags: public program inputs (ADR-096)", () => {
    // Every run, the student's own included, hands them to the program, which
    // can print them: withholding them here would only hide them from the
    // browser runtime, never from the student.
    expect(student.files).toEqual([{ name: "data.csv", content: FILE_CONTENT }]);
    expect(student.compileArgs).toBe(COMPILE_ARGS);
  });

  it("hands over the template already split, markers included", () => {
    expect(student.segments.map((s) => s.kind)).toEqual([
      "editable",
      "locked",
      "editable",
      "locked",
    ]);
    expect(student.segments.map((s) => s.text).join("")).toBe(codeConfig().template);
  });

  it("is stable: the same config gives the same view", () => {
    expect(JSON.stringify(codeServer.toStudent(codeConfig(), { ...view, seed: 99 }))).toBe(
      serialized,
    );
  });
});

describe("codeServer.toSolution", () => {
  it("carries the key, which is why the feedback policy gates it", () => {
    const solution = codeServer.toSolution(codeConfig(), view);
    expect(solution.referenceSolution).toBe(SECRET_REFERENCE);
    expect(solution.cases.map((c) => c.name)).toContain(SECRET_HIDDEN_NAME);
    expect(solution.compare.trimTrailing).toBe(true);
    // The hidden case travels whole here: its command line and its checks.
    expect(solution.cases[2]).toEqual({
      name: SECRET_HIDDEN_NAME,
      args: [SECRET_HIDDEN_ARG],
      stdin: SECRET_HIDDEN_STDIN,
      expected: SECRET_HIDDEN_EXPECTED,
      compareStdout: true,
      expectedExitCode: 0,
      points: 2,
      visible: false,
    });
  });
});

/** Is `secret` anywhere in `value` once serialized (its JSON escapes included)? */
const carries = (value: unknown, secret: string) => JSON.stringify(value).includes(JSON.stringify(secret).slice(1, -1));
const HIDDEN_SECRETS = [SECRET_HIDDEN_NAME, SECRET_HIDDEN_ARG, SECRET_HIDDEN_STDIN, SECRET_HIDDEN_EXPECTED];

describe("codeServer.studentSolution: a shown key never carries a hidden case (#998, D15)", () => {
  const solution = codeServer.toSolution(codeConfig(), view);
  const forStudent = codeServer.studentSolution!(solution, codeConfig());

  it("keeps the reference solution and the visible cases whole", () => {
    expect(forStudent).not.toBeNull();
    expect(forStudent!.referenceSolution).toBe(SECRET_REFERENCE);
    expect(forStudent!.cases).toEqual(solution.cases.filter((c) => c.visible));
    expect(forStudent!.cases.map((c) => c.name)).toEqual(["three items", "empty array"]);
    expect(forStudent!.compare).toEqual(solution.compare);
  });

  it("drops the hidden case: no name, command line, stdin nor expected output", () => {
    for (const secret of HIDDEN_SECRETS) expect(carries(forStudent, secret), secret).toBe(false);
  });
});

describe("codeServer.studentDetails under a shown key (#998, D15)", () => {
  const hiddenStdout = "HIDDEN-PROGRAM-OUTPUT";
  const graded = finalizeRunnerCode(
    codeConfig(),
    { regions: [] },
    FINALIZE_CTX,
    outcome([
      { stdout: "6\n" },
      { stdout: "0\n" },
      { stdout: hiddenStdout, stderr: SECRET_HIDDEN_STDIN, ms: 1234 },
    ]),
  ).details;

  for (const showHiddenCaseNames of [false, true]) {
    it(`reduces a hidden case to its verdict, names ${showHiddenCaseNames ? "open" : "closed"}`, () => {
      const shown = codeServer.studentDetails!(graded, { showKey: true, showHiddenCaseNames }) as CodeReviewDetails;
      expect(shown.cases[2]).toEqual({
        name: showHiddenCaseNames ? SECRET_HIDDEN_NAME : "#3",
        visible: false,
        points: 2,
        ok: false,
        failure: "failed",
      });
      // The visible cases travel whole: their expected output is published.
      expect(shown.cases.slice(0, 2)).toEqual(graded.cases.slice(0, 2));
      const secrets = [SECRET_HIDDEN_ARG, SECRET_HIDDEN_STDIN, SECRET_HIDDEN_EXPECTED, hiddenStdout, "1234"];
      for (const secret of showHiddenCaseNames ? secrets : [...secrets, SECRET_HIDDEN_NAME]) {
        expect(carries(shown, secret), secret).toBe(false);
      }
    });
  }
});
