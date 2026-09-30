/**
 * `@quiz/qt-mcq/testing` — the full configuration of the leak test
 * (invariant 4, docs/spec/05 §5.7). TEST-ONLY: nothing in `apps/*` imports it.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { MCQ_CONFIG_VERSION, McqConfigSchema, type McqConfig } from "./schema.js";

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

export const mcqLeakFixture: StudentLeakFixture<McqConfig> = {
  config: SECRET_CONFIG,
  /*
   * `mode` is absent on purpose: it is a member of `McqStudent` — the player
   * needs to know whether it draws radios or checkboxes — which is why it is
   * not in the common floor either.
   */
  forbiddenKeys: [
    // Out of the floor since R-06 (only `code` publishes it, on purpose); here
    // it still names nothing this type may publish.
    "compare",
    "allowNegative",
    "expected",
    "policy",
    "tolerance",
    "value",
  ],
  secrets: [
    // Every choice text is legitimately present, so the secret is not a text:
    // it is which index carries `correct`, and the truthy marker itself.
    "true",
    // The scoring policy is a secret of its own: knowing it would tell a
    // student whether guessing costs anything.
    "discordance",
    "inherit",
  ],
};
