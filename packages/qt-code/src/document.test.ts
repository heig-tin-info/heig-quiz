import { describe, expect, it } from "vitest";

import { markdownBody } from "@quiz/docexport/markdown";

import type { CodeDetails } from "./schema.js";
import { codeServer } from "./server.js";
import { codeConfig, SECRET_HIDDEN_EXPECTED, SECRET_HIDDEN_NAME, SECRET_REFERENCE } from "./test/fixtures.js";

const view = { seed: 0, itemId: "item-1", shuffle: false };

const details = (ok: boolean): CodeDetails => ({
  runner: "ok",
  compile: { ok: true, stderr: "", ms: 10 },
  cases: [
    { name: "three items", visible: true, points: 1, ok: true, exitCode: 0, ms: 3, timedOut: false, oom: false },
    { name: SECRET_HIDDEN_NAME, visible: false, points: 2, ok, exitCode: 0, ms: 3, timedOut: false, oom: false },
  ],
  earned: ok ? 3 : 1,
  total: 3,
  sourceSha256: null,
});

describe("the code question as a document (ADR-121 §2)", () => {
  const config = codeConfig();
  const student = codeServer.toStudent(config, view);

  it("reads the statement from the student view only: no key, no hidden test", () => {
    const text = markdownBody(codeServer.statementDoc!(student));
    expect(text).toContain(config.prompt);
    expect(text).toContain("```c\n#include <stdio.h>");
    for (const secret of [SECRET_REFERENCE, SECRET_HIDDEN_NAME, SECRET_HIDDEN_EXPECTED]) {
      expect(text).not.toContain(secret);
    }
  });

  it("gives the staff the reference solution and every case", () => {
    const text = markdownBody(codeServer.solutionDoc!(codeServer.toSolution(config, view), student));
    expect(text).toContain(SECRET_REFERENCE);
    expect(text).toContain(`| ${SECRET_HIDDEN_NAME} | hidden |`);
  });

  it("rebuilds the source from the stored template and lists the hidden tests' verdicts", () => {
    const answer = { regions: ["#include <stdio.h>\n", "    int total = 42;\n    return total;\n"] };
    const text = markdownBody(codeServer.answerDoc!(config, answer, details(false)));
    expect(text).toContain("int sum(const int *t, int n)\n{\n// @@endlock\n    int total = 42;");
    expect(text).toContain("int main(void) {");
    expect(text).toContain("Tests passed: 1/2");
    expect(text).toContain(`| ${SECRET_HIDDEN_NAME} | hidden | failed | 2 |`);
  });

  it("shows the source alone before any grading, and a misfit answer as such", () => {
    expect(codeServer.answerDoc!(config, { regions: ["", "x"] }, null)).toHaveLength(1);
    const misfit = markdownBody(codeServer.answerDoc!(config, { regions: ["a", "b", "c"] }, null));
    expect(misfit).toContain("no longer fits");
  });

  it("quotes the compiler's complaint", () => {
    const failed = { ...details(false), compile: { ok: false, stderr: "error: expected ';'", ms: 5 } };
    expect(markdownBody(codeServer.answerDoc!(config, { regions: ["", "x"] }, failed))).toContain(
      "Compilation failed:\n\n```text\nerror: expected ';'\n```",
    );
  });
});
