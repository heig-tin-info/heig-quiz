/** Test fixtures for the `diagram` suites (excluded from the build). */
import type { GradeContext, RunnerService } from "@quiz/core/server";

import { DiagramConfigSchema, type DiagramConfig } from "../schema.js";
import { SECRET_CONFIG } from "../testing.js";

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";

const noRunner: RunnerService = {
  run() {
    throw new Error("the diagram type must never call the runner");
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
    now: new Date("2026-09-30T10:00:00Z"),
    runner: noRunner,
  };
}

/** The full fixture of the leak test, with `over` on top. */
export function config(over: Partial<DiagramConfig> = {}): DiagramConfig {
  return DiagramConfigSchema.parse({ ...SECRET_CONFIG, ...over });
}
