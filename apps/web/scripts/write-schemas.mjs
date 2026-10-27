#!/usr/bin/env node
/**
 * Writes the JSON Schemas the platform publishes (criteria-3 contract,
 * ADR-119 §2) into `apps/web/public/schemas/`, which Vite copies into
 * `dist/`, served as `/schemas/criteria-3.json` and `/schemas/results-1.json`
 * — the `$id` of each. They are generated from their zod definitions
 * (`publishedSchemas` of `@quiz/contracts`), never edited, and NOT in git
 * (`.gitignore`): this script runs before `dev` and `build`, like
 * `copy-blockly-media.mjs`. `@quiz/contracts` must be built first, as for
 * the rest of the app.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { publishedSchemas } from "@quiz/contracts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "schemas");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const [name, schema] of Object.entries(publishedSchemas())) {
  await writeFile(join(OUT, name), `${JSON.stringify(schema, null, 2)}\n`);
}
