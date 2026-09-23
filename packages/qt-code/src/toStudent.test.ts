/**
 * The mandatory leak test (PLAN-MVP §2.5, docs/spec/05 §5.7, invariant 4).
 *
 * Two independent checks, because either one alone is easy to satisfy by
 * accident: a forbidden-key list on the serialized student view, and a search
 * for the literal secret values of a fully populated configuration.
 */
import { describe, expect, it } from "vitest";

import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";

import { CodeConfig, CodeStudent } from "./schema.js";
import { codeServer } from "./server.js";
import {
  codeConfig,
  SECRET_COMPILE_ARGS,
  SECRET_FILE_CONTENT,
  SECRET_HIDDEN_ARG,
  SECRET_HIDDEN_EXPECTED,
  SECRET_HIDDEN_NAME,
  SECRET_HIDDEN_STDIN,
  SECRET_REFERENCE,
} from "./test/fixtures.js";

/*
 * The shared floor (`@quiz/core/server`) plus what only `code` has. `expected`
 * is in neither: a VISIBLE case publishes its expected output on purpose —
 * the player shows "stdin / expected / got" and the student is meant to
 * compare them (docs/spec/04 §4.7). The hidden ones are covered by the value
 * search below, which is the check that actually matters here. `compare` is
 * out of the floor since audit R-06 and published on purpose (HOW, never
 * WHAT); its exact shape is pinned by a test of its own below.
 */
const FORBIDDEN_KEYS = [
  ...COMMON_FORBIDDEN_STUDENT_KEYS,
  "action",
  "content",
  "files",
  "policy",
  "tolerance",
];

const SECRET_VALUES = [
  SECRET_HIDDEN_STDIN,
  SECRET_HIDDEN_EXPECTED,
  SECRET_HIDDEN_NAME,
  // A hidden case's command line says as much as its stdin does.
  SECRET_HIDDEN_ARG,
  SECRET_REFERENCE,
  SECRET_FILE_CONTENT,
  SECRET_COMPILE_ARGS,
  "0x1004",
];

const view = { seed: 7, itemId: "item-1", shuffle: true };

describe("codeServer.toStudent", () => {
  const student = codeServer.toStudent(codeConfig(), view);
  const serialized = JSON.stringify(student);

  it("produces a value its own schema accepts", () => {
    expect(CodeStudent.safeParse(student).success).toBe(true);
  });

  it("leaks no forbidden key", () => {
    for (const key of FORBIDDEN_KEYS) {
      expect(serialized, key).not.toContain(`"${key}"`);
    }
  });

  it("leaks no secret value", () => {
    for (const secret of SECRET_VALUES) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

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
    for (const secret of SECRET_VALUES) {
      expect(JSON.stringify(published), secret).not.toContain(secret);
    }
  });

  it("says where the Run button executes, which the key never depends on", () => {
    expect(student.runtime).toBe("backend");
    const runno = CodeConfig.parse({ ...codeConfig(), runtime: "runno" });
    expect(codeServer.toStudent(runno, view).runtime).toBe("runno");
  });

  it("announces the extra files by name and size, never by content", () => {
    expect(student.filesPreview).toEqual([
      { name: "data.csv", bytes: SECRET_FILE_CONTENT.length },
    ]);
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
