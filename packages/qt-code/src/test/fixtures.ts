/** Shared fixtures: one fully populated config per shape the tests need. */
import type { RunnerOutcome } from "@quiz/core/server";

import { CodeConfig, type CodeLanguage } from "../schema.js";

/** The full fixture of the leak test, shared with the registry's contract test. */
export {
  C_TEMPLATE,
  codeConfig,
  SECRET_COMPILE_ARGS,
  SECRET_FILE_CONTENT,
  SECRET_HIDDEN_ARG,
  SECRET_HIDDEN_EXPECTED,
  SECRET_HIDDEN_NAME,
  SECRET_HIDDEN_STDIN,
  SECRET_REFERENCE,
} from "../testing.js";

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
