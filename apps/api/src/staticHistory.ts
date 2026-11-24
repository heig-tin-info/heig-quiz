import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rmdir, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/** How long a file absent from the served build stays available (ADR-110). */
export const RETENTION_MS = 30 * 24 * 3_600_000;

/**
 * The folders of a build whose files never change under their name, kept
 * across builds: `assets/` (Vite names each file after its content) and
 * `pdfjs/` (pdf.js's character maps, fonts and decoders, one folder per
 * pdf.js version, ADR-144 §6).
 */
export const RETAINED_DIRS = ["assets", "pdfjs"] as const;

/** Every file under `dir`, as paths relative to it; none when it does not exist. */
async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)));
}

/**
 * Keeps the files of earlier builds, so a tab opened before a deploy can
 * still load its lazy chunks, and its pdf.js its own data (ADR-110). Each
 * folder of {@link RETAINED_DIRS} of the build is copied into the same
 * folder of `historyDir` (a name never changes content: an existing one is
 * never rewritten), each file of the current build gets its mtime set to
 * `now` — the last time it was part of a served build — and a file left out
 * of every build for `RETENTION_MS` is deleted, with the folders it empties.
 */
export async function retainAssets(staticDir: string, historyDir: string, now = new Date()): Promise<void> {
  for (const folder of RETAINED_DIRS) {
    const source = join(staticDir, folder);
    const kept = join(historyDir, folder);
    await mkdir(kept, { recursive: true });
    const current = new Set(await filesUnder(source));
    for (const name of current) {
      const target = join(kept, name);
      // Through a temporary name: a boot killed mid-copy leaves no truncated file.
      if (!existsSync(target)) {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(source, name), `${target}.tmp`);
        await rename(`${target}.tmp`, target);
      }
      await utimes(target, now, now);
    }
    for (const name of await filesUnder(kept)) {
      if (current.has(name)) continue;
      const file = join(kept, name);
      if (now.getTime() - (await stat(file)).mtimeMs <= RETENTION_MS) continue;
      await unlink(file);
      // The folders it leaves empty go too (a whole pdf.js version, in time).
      for (let dir = dirname(file); dir !== kept; dir = dirname(dir)) {
        if ((await readdir(dir)).length > 0) break;
        await rmdir(dir);
      }
    }
  }
}
