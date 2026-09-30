/**
 * `@quiz/qt-rich/testing` — the full configuration of the leak test
 * (invariant 4, docs/spec/05 §5.7). TEST-ONLY: nothing in `apps/*` imports it.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { RichConfigSchema, type RichConfig } from "./schema.js";

/** The values only the grader may read: none of them may reach a student. */
const SECRET_VALUES = [
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

export const richLeakFixture: StudentLeakFixture<RichConfig> = {
  config: SECRET_CONFIG,
  /* What only `rich` holds: the model answer. */
  forbiddenKeys: ["compare", "expected", "reference"],
  secrets: SECRET_VALUES,
};
