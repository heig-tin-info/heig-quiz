#!/usr/bin/env node
/**
 * Copies the data pdf.js fetches at run time — the character maps, the
 * standard fonts, the ICC profiles and the WebAssembly image decoders — from
 * the installed `pdfjs-dist` into `apps/web/public/pdfjs/`, which Vite copies
 * into `dist/`, which the Dockerfile copies into the image: the document
 * viewer (`src/documents/`) then asks its own origin for `/pdfjs/…`, never a
 * CDN (the CSP's `default-src 'self'`). The worker is not here: Vite emits it
 * as a hashed asset (`src/documents/pdfWorker.ts`), so a tab never
 * pairs an old library with a new worker.
 *
 * The files are NOT in git (`.gitignore`): they are the package's, at the
 * version the lockfile pins, so this script runs before `dev`, `dev:mock`
 * and `build`, from `apps/web/package.json`, like `copy-blockly-media.mjs`.
 * No network: the source is `node_modules`. A missing folder is an error.
 *
 * Left behind: the scripting sandbox (`quickjs-eval.*`), since the viewer
 * runs no document script, and the licence files, which stay in the package.
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public", "pdfjs");

// `pdfjs-dist` has no `exports` map: its `package.json` is reachable.
const PKG = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

/** The folders pdf.js reads (`cMapUrl`, `standardFontDataUrl`, `iccUrl`, `wasmUrl`), and what each keeps. */
const FOLDERS = {
  cmaps: () => true,
  standard_fonts: (name) => !/^LICENSE/.test(name),
  iccs: (name) => !/^LICENSE/.test(name),
  wasm: (name) => !/^LICENSE/.test(name) && !name.startsWith("quickjs"),
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
let count = 0;
for (const [folder, keep] of Object.entries(FOLDERS)) {
  const source = join(PKG, folder);
  const names = (await readdir(source)).filter(keep);
  if (names.length === 0) throw new Error(`pdfjs assets: nothing to copy in ${source}`);
  await mkdir(join(OUT, folder), { recursive: true });
  for (const name of names) await cp(join(source, name), join(OUT, folder, name), { recursive: true });
  count += names.length;
}
console.log(`pdfjs assets: ${count} files from ${PKG} -> ${OUT}`);
