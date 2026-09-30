/** Test fixtures for the `mcq` suites (excluded from the build). */
import type { GradeContext, RunnerService } from "@quiz/core/server";
import { MCQ_CONFIG_VERSION, McqConfigSchema, type McqConfig } from "../schema.js";

/** No question type of WP2 touches the runner; calling it is a bug, so it throws. */
const noRunner: RunnerService = {
  run() {
    throw new Error("the mcq type must never call the runner");
  },
  health() {
    return Promise.resolve({ ok: false, languages: [], queued: 0, avgMs: null });
  },
};

/**
 * `defaults` is what an evaluation hands the grader: pass none and an
 * `inherit` question falls back to `all_or_nothing`, exactly like the
 * teacher's Try panel.
 */
export function gradeContext(
  itemPoints: number,
  defaults?: Readonly<Record<string, unknown>>,
  seed = 7,
): GradeContext {
  return {
    seed,
    itemId: "item-1",
    attemptId: "attempt-1",
    itemPoints,
    now: new Date("2026-09-20T10:00:00Z"),
    runner: noRunner,
    ...(defaults === undefined ? {} : { defaults }),
  };
}

/** A four-choice `multiple` config: two keys, two distractors. */
export function multipleConfig(over: Partial<McqConfig> = {}): McqConfig {
  return McqConfigSchema.parse({
    configVersion: MCQ_CONFIG_VERSION,
    prompt: "Which declarations are valid in C17?",
    choices: [
      { text: "`int a[] = {1,2,3};`", correct: true },
      { text: "`int a[3] = {};`", correct: true },
      { text: "`int a[] ;`", correct: false },
      { text: "`int a[-1];`", correct: false },
    ],
    mode: "multiple",
    ...over,
  });
}

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";
