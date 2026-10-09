/** Test fixtures for the `mcq` suites (excluded from the build). */
import { MCQ_CONFIG_VERSION, McqConfigSchema, type McqConfig } from "../schema.js";

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
