/** Shared fixtures: one fully populated config per shape the tests need. */
import type { RunnerOutcome } from "@quiz/core/server";

import { CodeConfig, type CodeLanguage } from "../schema.js";

/** The C template of PLAN-MVP §2.4: two locked regions, two editable ones. */
export const C_TEMPLATE = `#include <stdio.h>
// @@lock
int sum(const int *t, int n)
{
// @@endlock
    int total = 0;
    return total;
// @@lock
}

int main(void) {
    int n;
    if (scanf("%d", &n) != 1) return 1;
    printf("%d\\n", 0);
    return 0;
}
// @@endlock
`;

export const SECRET_HIDDEN_STDIN = "4\n-1 -2 3 5\n";
export const SECRET_HIDDEN_EXPECTED = "5 (hidden-expected-marker)";
export const SECRET_HIDDEN_NAME = "negative-values";
export const SECRET_REFERENCE = "int secret_reference_solution(void) { return 42; }";
export const SECRET_FILE_CONTENT = "id,answer\n1,0x1004\n";
export const SECRET_COMPILE_ARGS = "-Wall -Wextra -std=c17 -DSECRET_FLAG";

export function codeConfig(): CodeConfig {
  return CodeConfig.parse({
    configVersion: 1,
    prompt: "Sum the integers read on stdin.",
    language: "c",
    template: C_TEMPLATE,
    files: [{ name: "data.csv", content: SECRET_FILE_CONTENT }],
    action: "run",
    compileArgs: SECRET_COMPILE_ARGS,
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
    runsPerMinute: 10,
    allOrNothing: false,
    referenceSolution: SECRET_REFERENCE,
    tests: {
      mode: "io",
      compare: { trimTrailing: true, ignoreCase: false, numeric: null },
      cases: [
        { name: "three items", stdin: "3\n1 2 3\n", expected: "6\n", visible: true, points: 1 },
        { name: "empty array", stdin: "0\n", expected: "0\n", visible: true, points: 1 },
        {
          name: SECRET_HIDDEN_NAME,
          stdin: SECRET_HIDDEN_STDIN,
          expected: SECRET_HIDDEN_EXPECTED,
          visible: false,
          points: 2,
        },
      ],
    },
  });
}

/** A one-case config in the given language, with a marker in its own comment syntax. */
export function templateFor(language: CodeLanguage): string {
  const open = language === "python" ? "# @@lock" : "// @@lock";
  const close = language === "python" ? "# @@endlock" : "// @@endlock";
  return `${open}\nHEADER\n${close}\nBODY\n${open}\nFOOTER\n${close}\n`;
}

export function configFor(language: CodeLanguage): CodeConfig {
  return CodeConfig.parse({
    configVersion: 1,
    prompt: "p",
    language,
    template: templateFor(language),
    tests: { mode: "io", cases: [{ name: "one", stdin: "", expected: "", points: 1 }] },
  });
}

/** A runner outcome whose cases all pass the fixture config. */
export function outcome(
  cases: Array<Partial<RunnerOutcome["cases"][number]>>,
  compile: Partial<RunnerOutcome["compile"]> = {},
): RunnerOutcome {
  return {
    compile: { ok: true, stdout: "", stderr: "", ms: 12, ...compile },
    cases: cases.map((c) => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      ms: 5,
      timedOut: false,
      oom: false,
      truncated: false,
      ...c,
    })),
  };
}

export const FINALIZE_CTX = {
  seed: 7,
  itemId: "item-1",
  attemptId: "attempt-1",
  itemPoints: 10,
  now: new Date("2026-09-20T10:00:00.000Z"),
};
