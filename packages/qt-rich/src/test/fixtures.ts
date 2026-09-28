/** Test fixtures for the `rich` suites (excluded from the build). */
import type { GradeContext, RunnerService } from "@quiz/core/server";
import { RichConfigSchema, type RichConfig } from "../schema.js";

const noRunner: RunnerService = {
  run() {
    throw new Error("the rich type must never call the runner");
  },
  health() {
    return Promise.resolve({ ok: false, languages: [], queued: 0, avgMs: null });
  },
};

export function gradeContext(itemPoints: number): GradeContext {
  return {
    seed: 7,
    itemId: "item-1",
    attemptId: "attempt-1",
    itemPoints,
    now: new Date("2026-09-28T10:00:00Z"),
    runner: noRunner,
  };
}

export function config(over: Partial<RichConfig> = {}): RichConfig {
  return RichConfigSchema.parse({
    configVersion: 1,
    prompt: "Explain why a stack overflow crashes a C program.",
    ...over,
  });
}

/** The values only the grader may read: none of them may reach a student. */
export const SECRET_VALUES = [
  "RUBRIC-SECRET-names the guard page",
  "REFERENCE-SECRET-the stack grows down into unmapped memory",
] as const;

export const SECRET_CONFIG: RichConfig = RichConfigSchema.parse({
  configVersion: 1,
  prompt: "Explain why a stack overflow crashes a C program.",
  rubric: `- 2 pts: ${SECRET_VALUES[0]}\n- 1 pt: mentions recursion`,
  reference: SECRET_VALUES[1],
  maxChars: 3000,
  format: "markdown",
});
