/**
 * The mandatory leak test (PLAN-MVP §2.5, docs/spec/05 §5.7, invariant 4).
 *
 * Two independent checks, because either one alone is easy to satisfy by
 * accident: a forbidden-key list on the serialized student view, and a search
 * for the literal secret values of a fully populated configuration.
 */
import { describe, expect, it } from "vitest";

import { CodeStudent } from "./schema.js";
import { codeServer } from "./server.js";
import {
  codeConfig,
  SECRET_COMPILE_ARGS,
  SECRET_FILE_CONTENT,
  SECRET_HIDDEN_EXPECTED,
  SECRET_HIDDEN_NAME,
  SECRET_HIDDEN_STDIN,
  SECRET_REFERENCE,
} from "./test/fixtures.js";

/*
 * The list of §2.5, minus `expected`: a VISIBLE case publishes its expected
 * output on purpose — the player shows "stdin / expected / got" and the
 * student is meant to compare them (docs/spec/04 §4.7). The hidden ones are
 * covered by the value search below, which is the check that actually
 * matters here.
 */
const FORBIDDEN_KEYS = [
  "correct",
  "matchers",
  "answers",
  "pattern",
  "tolerance",
  "policy",
  "penalty",
  "compare",
  "compileArgs",
  "referenceSolution",
  "explanation",
  "internalName",
  "tags",
  "difficulty",
  "rubric",
  "content",
  "files",
  "action",
];

const SECRET_VALUES = [
  SECRET_HIDDEN_STDIN,
  SECRET_HIDDEN_EXPECTED,
  SECRET_HIDDEN_NAME,
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
      stdin: "3\n1 2 3\n",
      expected: "6\n",
      points: 1,
    });
    expect(student.hiddenCount).toBe(1);
    expect(student.hiddenPoints).toBe(2);
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
  });
});
