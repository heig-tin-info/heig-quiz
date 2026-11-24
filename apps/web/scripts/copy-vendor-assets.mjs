#!/usr/bin/env node
/**
 * Copies the files two libraries fetch at run time from the installed
 * packages into `apps/web/public/`, which Vite copies into `dist/`, which
 * the Dockerfile copies into the image: the page then asks its own origin
 * for them, never a third-party host (ADR-015 §4, the CSP's
 * `default-src 'self'`).
 *
 * - Blockly's media (cursors, sprites, the dropdown arrow) into
 *   `blockly-media/` (ADR-103 §11); the sounds stay behind, the workspace is
 *   mounted with `sounds: false`.
 * - pdf.js's character maps, standard fonts, ICC profiles and WebAssembly
 *   decoders into `pdfjs/<pdf.js version>/` (ADR-144 §6): a folder per
 *   version, kept across deploys like `assets/` (ADR-110,
 *   `apps/api/src/staticHistory.ts`), so a tab opened before an upgrade
 *   reads its own version's files. The viewer asks for the folder of the
 *   version it loaded (`src/documents/pdfjs.ts`). The scripting sandbox
 *   (`quickjs-eval.*`) and the licence files stay in the package. The worker
 *   is not here: Vite builds it (`src/documents/pdfWorker.ts`).
 *
 * The files are NOT in git (`.gitignore`): they are the packages', at the
 * versions the lockfile pins, so this script runs before `dev`, `dev:mock`
 * and `build` (`apps/web/package.json`). No network: the source is
 * `node_modules`. A missing package or an empty folder is an error.
 */
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const require = createRequire(import.meta.url);

const notLicence = (name) => !/^LICENSE/.test(name);

/**
 * Blockly is a dependency of `@quiz/qt-blocks`, not of the app: it is found
 * from there. Its `exports` map names no `package.json`, so its media folder
 * is reached from the resolved entry point, at the package root.
 */
function blockly() {
  const qtBlocks = require.resolve("@quiz/qt-blocks/package.json");
  return dirname(createRequire(qtBlocks).resolve("blockly"));
}

/** `pdfjs-dist`'s root (it has no `exports` map) and its version. */
async function pdfjs() {
  const manifest = require.resolve("pdfjs-dist/package.json");
  const { version } = JSON.parse(await readFile(manifest, "utf8"));
  return { root: dirname(manifest), version };
}

/**
 * What is copied: each entry empties `clean` under `public/`, then copies
 * each source folder into `to`, keeping the names `keep` accepts.
 */
async function table() {
  const pdf = await pdfjs();
  return [
    {
      label: "blockly media",
      clean: "blockly-media",
      folders: [{ from: join(blockly(), "media"), to: "blockly-media", keep: (name) => !/\.(mp3|ogg|wav)$/.test(name) }],
    },
    {
      label: `pdf.js ${pdf.version} data`,
      clean: "pdfjs",
      folders: [
        { from: join(pdf.root, "cmaps"), to: `pdfjs/${pdf.version}/cmaps`, keep: () => true },
        { from: join(pdf.root, "standard_fonts"), to: `pdfjs/${pdf.version}/standard_fonts`, keep: notLicence },
        { from: join(pdf.root, "iccs"), to: `pdfjs/${pdf.version}/iccs`, keep: notLicence },
        {
          from: join(pdf.root, "wasm"),
          to: `pdfjs/${pdf.version}/wasm`,
          keep: (name) => notLicence(name) && !name.startsWith("quickjs"),
        },
      ],
    },
  ];
}

for (const { label, clean, folders } of await table()) {
  await rm(join(PUBLIC, clean), { recursive: true, force: true });
  let count = 0;
  for (const { from, to, keep } of folders) {
    const names = (await readdir(from)).filter(keep);
    if (names.length === 0) throw new Error(`${label}: nothing to copy in ${from}`);
    await mkdir(join(PUBLIC, to), { recursive: true });
    for (const name of names) await cp(join(from, name), join(PUBLIC, to, name), { recursive: true });
    count += names.length;
  }
  console.log(`${label}: ${count} entries -> public/${clean}`);
}
