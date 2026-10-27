#!/usr/bin/env node
/**
 * Writes the JSON Schemas the platform publishes (`results-1.json`,
 * `criteria-3.json`, criteria-3 contract) into `schemas/`, generated from
 * their zod definitions (`publishedSchemas` of `src/checkResults.ts`). Run
 * by `pnpm build` after `tsc`: the files are build output, never edited.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { publishedSchemas } from "../dist/checkResults.js";

const dir = fileURLToPath(new URL("../schemas/", import.meta.url));
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(publishedSchemas())) writeFileSync(`${dir}${name}`, `${JSON.stringify(schema, null, 2)}\n`);
