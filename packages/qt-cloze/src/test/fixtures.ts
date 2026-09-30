/** Test fixtures for the `cloze` suites (excluded from the build). */
import type { GradeContext, RunnerService } from "@quiz/core/server";
import { CLOZE_CONFIG_VERSION, ClozeConfigSchema, type ClozeConfig } from "../schema.js";

const noRunner: RunnerService = {
  run() {
    throw new Error("the cloze type must never call the runner");
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
    now: new Date("2026-09-20T10:00:00Z"),
    runner: noRunner,
  };
}

export function config(text: string, over: Partial<ClozeConfig> = {}): ClozeConfig {
  return ClozeConfigSchema.parse({ configVersion: CLOZE_CONFIG_VERSION, text, ...over });
}

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";
