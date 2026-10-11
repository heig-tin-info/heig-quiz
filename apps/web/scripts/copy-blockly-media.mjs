#!/usr/bin/env node
/**
 * Copies Blockly's media (cursors, sprites, the dropdown arrow) from the
 * installed package into `apps/web/public/blockly-media/`, which Vite copies
 * into `dist/`, which the Dockerfile copies into the image: the `blocks`
 * workspace then asks its own origin for `/blockly-media/…` (ADR-103 §11,
 * ADR-015 §4 — nothing from a third-party host; sounds are off anyway).
 *
 * The files are NOT in git (`.gitignore`): they are the package's, at the
 * version the lockfile pins, so this script runs before `dev`, `dev:mock`
 * and `build`, explicitly from `apps/web/package.json`, like
 * `fetch-runtimes.mjs`. No network: the source is `node_modules`. A missing
 * package is an error — the web app cannot ship a `blocks` surface without
 * its media.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public", "blockly-media");

// Blockly is a dependency of `@quiz/qt-blocks`, not of the app: it is found
// from there. Its `exports` map names no `package.json`, so the media folder
// is reached from the resolved entry point, which sits at the package root.
const qtBlocks = createRequire(import.meta.url).resolve("@quiz/qt-blocks/package.json");
const blocklyEntry = createRequire(qtBlocks).resolve("blockly");
const MEDIA = join(dirname(blocklyEntry), "media");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
// The sounds stay behind: the workspace is mounted with `sounds: false`.
await cp(MEDIA, OUT, { recursive: true, filter: (source) => !/\.(mp3|ogg|wav)$/.test(source) });
console.log(`blockly media: ${MEDIA} -> ${OUT}`);
