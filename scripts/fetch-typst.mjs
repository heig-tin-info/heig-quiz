#!/usr/bin/env node
/**
 * Downloads the pinned Typst binary the PDF exports compile with (ADR-125 §1)
 * and puts it at `<out>/typst`.
 *
 * The release tarball is checked against the SHA-256 below before anything is
 * extracted; a mismatch refuses, whatever the cause. The binary is the static
 * musl build: no shared library, so the runtime image only copies it
 * (`Dockerfile`), and CI puts it on PATH for the API's PDF tests
 * (`.github/workflows/ci.yml`). Extraction needs `tar` with `xz`.
 *
 * Usage: node scripts/fetch-typst.mjs <out-dir>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Pinned on 2026-11-04 from the GitHub release v0.15.1 (published
 * 2026-07-17); the digest is the one GitHub lists for the asset. A digest
 * that no longer matches means the upstream file changed: find out what it
 * became before touching this line.
 */
const TYPST_VERSION = "0.15.1";
const ASSET = "typst-x86_64-unknown-linux-musl";
const SHA256 = "a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c";
const URL = `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/${ASSET}.tar.xz`;

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/fetch-typst.mjs <out-dir>");
  process.exit(2);
}
if (process.arch !== "x64" || process.platform !== "linux") {
  console.error(`fetch-typst: only linux x64 is pinned (this is ${process.platform} ${process.arch})`);
  process.exit(1);
}

const res = await fetch(URL);
if (!res.ok) {
  console.error(`fetch-typst: ${URL} answered ${res.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await res.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== SHA256) {
  console.error(`fetch-typst: refused, sha256 ${digest} is not the pinned ${SHA256}`);
  process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), "fetch-typst-"));
try {
  const archive = join(work, `${ASSET}.tar.xz`);
  await writeFile(archive, bytes);
  await mkdir(resolve(out), { recursive: true });
  // The binary alone, without its directory.
  execFileSync("tar", ["-xJf", archive, "-C", resolve(out), "--strip-components=1", `${ASSET}/typst`], {
    stdio: "inherit",
  });
  console.log(`fetch-typst: typst ${TYPST_VERSION} at ${join(resolve(out), "typst")}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
