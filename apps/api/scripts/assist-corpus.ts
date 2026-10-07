/**
 * Builds the teacher assistant's corpus (ADR-080 §5) into
 * `dist/assist-corpus.json`, the artifact the server loads: the last step of
 * `pnpm --filter @quiz/api build`, run after `tsc`. It fails when the guide
 * or the help is missing, so an image never ships without the documentation
 * of its own commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCorpus } from "@quiz/domain";

import { readCorpusSources } from "../src/modules/assist/corpus.js";

const corpus = buildCorpus(readCorpusSources());
// Where `CORPUS_ARTIFACT` points from the compiled server.
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/assist-corpus.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(corpus));
console.log(`assist corpus ${corpus.version}: ${corpus.pages.length} pages → ${out}`);
