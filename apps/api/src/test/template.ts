/**
 * The migrated database every db test starts from, built ONCE per test run.
 *
 * A fresh PGlite runs `initdb` (about 1.4 s) and then the whole Drizzle
 * migration chain; a PGlite loaded from a data directory skips both (about
 * 0.4 s). So vitest's `globalSetup` (this file's default export, wired in
 * vitest.config.ts) migrates one empty database with the real migrator, dumps
 * its data directory to a tarball, and every test file loads its own copy of
 * that tarball: a clean, fully migrated database of its own, byte for byte
 * the one a fresh migration would have produced, shared with nobody.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { inject } from "vitest";
import type { TestProject } from "vitest/node";

import { MIGRATIONS_DIR } from "../paths.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The tarball of the migrated data directory; see {@link templateDataDir}. */
    pgliteTemplate: string;
  }
}

/** The real migration chain, through the PGlite migrator `createDb` uses. */
export async function migrateFresh(client: PGlite): Promise<void> {
  await migrate(drizzle(client) as never, { migrationsFolder: MIGRATIONS_DIR });
}

/** globalSetup: migrate once, dump, hand the file's path to every worker. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), "quiz-pglite-template-"));
  const file = join(dir, "migrated.tar");
  const client = new PGlite();
  await migrateFresh(client);
  // Uncompressed: 40 MB on disk, but no gunzip in every test file.
  await writeFile(file, Buffer.from(await (await client.dumpDataDir("none")).arrayBuffer()));
  await client.close();
  project.provide("pgliteTemplate", file);
  return () => rm(dir, { recursive: true, force: true });
}

let cached: Promise<Blob | null> | undefined;

/**
 * The template, for `new PGlite({ loadDataDir })`; null when the run has no
 * globalSetup (a config that does not wire it), and the caller then migrates
 * a fresh database itself.
 */
export function templateDataDir(): Promise<Blob | null> {
  cached ??= (async () => {
    const file = inject("pgliteTemplate");
    return file ? new Blob([await readFile(file)]) : null;
  })();
  return cached;
}

/**
 * A migrated PGlite of its own: in memory without `dataDir`, in that
 * directory otherwise (which must be new).
 */
export async function migratedPglite(dataDir?: string): Promise<PGlite> {
  const template = await templateDataDir();
  const client = new PGlite({ ...(dataDir ? { dataDir } : {}), ...(template ? { loadDataDir: template } : {}) });
  await (template ? client.waitReady : migrateFresh(client));
  return client;
}
