/** Test fixtures for the `short` suites (excluded from the build). */
import type { GradeContext, RunnerService } from "@quiz/core/server";
import { ShortConfigSchema, type ShortConfig } from "../schema.js";

const noRunner: RunnerService = {
  run() {
    throw new Error("the short type must never call the runner");
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

export function config(over: Partial<ShortConfig> = {}): ShortConfig {
  return ShortConfigSchema.parse({
    configVersion: 2,
    prompt: "Which directive includes the standard I/O header?",
    matchers: [{ kind: "exact", value: "#include <stdio.h>" }],
    ...over,
  });
}

/** The full fixture of the leak test, shared with the registry's contract test. */
export { SECRET_CONFIG } from "../testing.js";
