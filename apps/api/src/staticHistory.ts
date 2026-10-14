import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";

/** How long a file absent from the served build stays available (ADR-110). */
export const RETENTION_MS = 30 * 24 * 3_600_000;

/**
 * Keeps the hashed files of earlier builds, so a tab opened before a deploy
 * can still load its lazy chunks (ADR-110). The build's `assets/` is copied
 * into `<history>/assets/` (a name is a content hash: an existing one is
 * never rewritten), each file of the current build gets its mtime set to
 * `now` — the last time it was part of a served build — and a file left out
 * of every build for `RETENTION_MS` is deleted.
 */
export async function retainAssets(staticDir: string, historyDir: string, now = new Date()): Promise<void> {
  const source = join(staticDir, "assets");
  const kept = join(historyDir, "assets");
  await mkdir(kept, { recursive: true });
  const current = new Set(await readdir(source));
  for (const name of current) {
    const target = join(kept, name);
    // Through a temporary name: a boot killed mid-copy leaves no truncated chunk.
    if (!existsSync(target)) {
      await copyFile(join(source, name), `${target}.tmp`);
      await rename(`${target}.tmp`, target);
    }
    await utimes(target, now, now);
  }
  for (const name of await readdir(kept)) {
    if (current.has(name)) continue;
    const file = join(kept, name);
    if (now.getTime() - (await stat(file)).mtimeMs > RETENTION_MS) await unlink(file);
  }
}
