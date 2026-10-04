/**
 * `@quiz/qt-brainstorm/testing` — the full configuration of the leak test
 * (invariant 4). TEST-ONLY. A brainstorm holds no key: the fixture still
 * proves the common floor of forbidden keys never comes out of `toStudent`.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { BrainstormConfigSchema, type BrainstormConfig } from "./schema.js";

export const brainstormLeakFixture: StudentLeakFixture<BrainstormConfig> = {
  config: BrainstormConfigSchema.parse({
    configVersion: 1,
    prompt: "What makes something a living being?",
    maxIdeas: 4,
  }),
  forbiddenKeys: ["configVersion"],
  secrets: [],
};
