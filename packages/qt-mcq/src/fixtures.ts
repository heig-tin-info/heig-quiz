/**
 * Test fixtures. Kept out of the build (`tsconfig.json` excludes tests only, so
 * this file compiles too — it is small, typed and shared by four suites).
 */
import type { GradeContext, RunnerService } from "@quiz/core/server";
import { MCQ_CONFIG_VERSION, McqConfigSchema, type McqConfig } from "./schema.js";

/** No question type of WP2 touches the runner; calling it is a bug, so it throws. */
export const noRunner: RunnerService = {
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

/** The full fixture of the leak test: every secret a config can hold. */
export const SECRET_CONFIG: McqConfig = McqConfigSchema.parse({
  configVersion: MCQ_CONFIG_VERSION,
  prompt: "Let `int *p` point at `0x1000`. What is `p + 1`?",
  choices: [
    { text: "0x1001", correct: false },
    { text: "0x1004", correct: true },
    { text: "0x1008", correct: false },
  ],
  mode: "single",
  // Not the default: the leak test then has a VALUE to search the student
  // view for, and not only a key name.
  policy: "discordance",
  shuffleChoices: true,
});
