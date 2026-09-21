#!/usr/bin/env node
/**
 * Downloads the WebAssembly language runtimes the browser runner needs.
 *
 * They are SELF-HOSTED (ADR-015): an exam room behind an IP allowlist reaches
 * the platform and nothing else, so `https://runno.dev/langs/...` — which is
 * where `@runno/runtime` fetches from — is not a URL a student's browser can
 * open. The files land in `apps/web/public/runtimes/`, which Vite copies into
 * `dist/`, which the Dockerfile copies into the image: the browser then asks
 * its own origin for `/runtimes/clang.wasm`.
 *
 * They are NOT in git (77 MB, `.gitignore`), so this script runs before `dev`
 * and before `build` — explicitly, from `apps/web/package.json`, not through a
 * `prebuild` lifecycle hook that pnpm may or may not run.
 *
 * Each file is pinned by SHA-256. A file already on disk with the right digest
 * is left alone, so the second run costs nothing. A download that cannot be
 * made (an offline build machine) is a WARNING and not an error: the app still
 * works, the browser runner simply refuses to load and the backend runner
 * takes over, which is the fallback rule of `src/runner/index.ts`.
 *
 * Usage: node scripts/fetch-runtimes.mjs [--check]
 *   --check  verify only, download nothing, exit non-zero if anything is missing.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public", "runtimes");
const BASE = "https://runno.dev/langs";

/**
 * Pinned on 2026-09-21 from runno.dev, the distribution `@runno/runtime@0.10.0`
 * points at. clang and wasm-ld are binji's wasm-clang; python is VMware's
 * WebAssembly Language Runtimes build. A digest that no longer matches means
 * the upstream file changed: check what it became before touching this table.
 */
const FILES = [
  { name: "clang.wasm", sha256: "2a466f0e990329d3230b869d04fc20803eae96a7feb3a3f6c93e25a77b8aed1d", bytes: 31214472 },
  { name: "wasm-ld.wasm", sha256: "36419ed202011765222098d7701218378b67f634d50f0a4625059ae2c9860f48", bytes: 19490094 },
  { name: "clang-fs.tar.gz", sha256: "7ed12063619882e4dfa710ab371fc91848b256f85a4075747e8bd5c167902b50", bytes: 1790862 },
  { name: "python-3.11.3.wasm", sha256: "658cb6add2bbf8dfe84d67fb85430956d5a8b2b1d694d33432d654cdf048f813", bytes: 20538911 },
  { name: "python-3.11.3.tar.gz", sha256: "8c42694e45f2f1162114c70507c3da4c7cf983663e2b95660af521a9685d2a0c", bytes: 4066590 },
];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function present(file) {
  try {
    const bytes = await readFile(join(OUT, file.name));
    return digest(bytes) === file.sha256;
  } catch {
    return false;
  }
}

async function download(file) {
  const response = await fetch(`${BASE}/${file.name}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const got = digest(bytes);
  if (got !== file.sha256) {
    throw new Error(`checksum mismatch: expected ${file.sha256}, got ${got}`);
  }
  // Written aside and renamed: an interrupted download must not leave a
  // half file that the next run would serve to a browser.
  const target = join(OUT, file.name);
  await writeFile(`${target}.part`, bytes);
  await rename(`${target}.part`, target);
  return bytes.byteLength;
}

const check = process.argv.includes("--check");
await mkdir(OUT, { recursive: true });

let missing = 0;
let fetched = 0;
for (const file of FILES) {
  if (await present(file)) continue;
  if (check) {
    console.error(`runtimes: missing ${file.name}`);
    missing += 1;
    continue;
  }
  process.stdout.write(`runtimes: fetching ${file.name} (${mb(file.bytes)})… `);
  try {
    fetched += await download(file);
    process.stdout.write("ok\n");
  } catch (error) {
    process.stdout.write("failed\n");
    console.warn(
      `runtimes: could not fetch ${file.name} (${error.message}).\n` +
        "  The browser code runner will be unavailable in this build and the\n" +
        "  backend runner will serve every run instead (src/runner/index.ts).",
    );
    missing += 1;
  }
}

if (check && missing > 0) process.exit(1);
if (fetched > 0) console.log(`runtimes: ${mb(fetched)} downloaded into public/runtimes/`);
