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

/** The full fixture of the leak test, shared with the registry's contract test. */
export { SECRET_CONFIG } from "../testing.js";
