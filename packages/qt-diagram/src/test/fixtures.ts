/** Test fixtures for the `diagram` suites (excluded from the build). */

import { DiagramConfigSchema, type DiagramConfig } from "../schema.js";
import { SECRET_CONFIG } from "../testing.js";

/** The full fixture of the leak test (`../testing.ts`), shared with the registry's contract test. */
export * from "../testing.js";

/** The full fixture of the leak test, with `over` on top. */
export function config(over: Partial<DiagramConfig> = {}): DiagramConfig {
  return DiagramConfigSchema.parse({ ...SECRET_CONFIG, ...over });
}
