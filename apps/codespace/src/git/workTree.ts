/**
 * The workspace's tree from the confined reader's listing and archive (the
 * portal's invariant 15): bytes written as blobs into the collection's own
 * repository by one `git fast-import`, never a path of `work/` opened on the
 * host. Entries are `100644`/`100755` (the owner's execute bit) or `120000`
 * (a link, its target as the blob). What the reader could not read — a
 * listed file the archive lacks, a directory git could not open, a name
 * left out — is returned for `withUnreadableKept`.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";

import { COLLECTION_ENTRIES_MAX, type CollectionTreeEntry } from "@quiz/domain";

import type { WorkspaceReader } from "../engine/reader.js";
import { GitError, gitEnv } from "./gitRunner.js";
import { ArchiveTooLarge, readWorkArchive } from "./workArchive.js";

export interface WorkTree {
  entries: CollectionTreeEntry[];
  /** Files and directories not read (`""`: the work tree itself). */
  unreadable: string[];
  /** Names left out of the listing (not UTF-8, a control character, too long): neither read nor kept. */
  skipped: number;
}

/** `buf` on `stream`, waiting when it is full; a stream that broke rejects. */
function write(stream: Writable, buf: Buffer | string): Promise<void> {
  const stopped = () => new GitError("git fast-import stopped", ["fast-import"]);
  return new Promise((resolve, reject) => {
    if (stream.destroyed) return reject(stopped());
    if (stream.write(buf)) return resolve();
    const done = (fn: () => void) => () => {
      stream.off("drain", drained);
      stream.off("close", closed);
      fn();
    };
    const drained = done(resolve);
    const closed = done(() => reject(stopped()));
    stream.once("drain", drained);
    stream.once("close", closed);
  });
}

/**
 * One `git fast-import` writing blobs only, each named by a mark; above 1 MiB
 * a blob is streamed to the pack, not held. `finish` maps marks to shas.
 */
function blobImport(repoDir: string, marksFile: string) {
  const child = spawn(
    "git",
    ["--git-dir", repoDir, "fast-import", "--quiet", "--done", "--big-file-threshold=1m", `--export-marks=${marksFile}`],
    { env: gitEnv(), stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    if (stderr.length < 8192) stderr += c.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(-1));
  });
  child.stdin.on("error", () => undefined);
  let marks = 0;

  return {
    async blob(size: number, data: AsyncIterable<Buffer>): Promise<number> {
      const mark = ++marks;
      await write(child.stdin, `blob\nmark :${mark}\ndata ${size}\n`);
      for await (const chunk of data) await write(child.stdin, chunk);
      await write(child.stdin, "\n");
      return mark;
    },
    async finish(): Promise<Map<number, string>> {
      await write(child.stdin, "done\n");
      child.stdin.end();
      const code = await exited;
      if (code !== 0) throw new GitError(`git fast-import failed (${code}): ${stderr.slice(0, 400)}`, ["fast-import"]);
      const shas = new Map<number, string>();
      for (const line of (await readFile(marksFile, "utf8")).split("\n")) {
        const m = /^:(\d+) ([0-9a-f]{40})$/.exec(line);
        if (m) shas.set(Number(m[1]), m[2]!);
      }
      return shas;
    },
    abort(): void {
      child.kill("SIGKILL");
    },
  };
}

async function* once(buf: Buffer): AsyncIterable<Buffer> {
  yield buf;
}

/**
 * Reads `workDir` through `reader` into `repoDir` (a bare repository whose
 * parent directory is the collection's own). Throws what the reader throws,
 * `ArchiveRefused` or `ArchiveTooLarge` from the archive, `GitError` from git.
 */
export async function readWorkTree(reader: WorkspaceReader, workDir: string, repoDir: string, timeoutMs: number, maxBytes: number): Promise<WorkTree> {
  return reader.read(workDir, timeoutMs, async (listing, archive) => {
    // Bounded before any work: the portal's own work on a listing cannot be interrupted once it runs.
    if (listing.paths.length > COLLECTION_ENTRIES_MAX) throw new ArchiveTooLarge(listing.closed.length + listing.skipped);
    const blobs = blobImport(repoDir, join(repoDir, "..", "marks"));
    try {
      const marked: { mode: string; path: string; mark: number }[] = [];
      const kept = await readWorkArchive(archive, new Set(listing.paths), maxBytes, {
        async file(path, executable, size, data) {
          marked.push({ mode: executable ? "100755" : "100644", path, mark: await blobs.blob(size, data) });
        },
        async symlink(path, target) {
          marked.push({ mode: "120000", path, mark: await blobs.blob(target.length, once(target)) });
        },
      });
      const shas = await blobs.finish();
      return {
        entries: marked.map(({ mode, path, mark }) => {
          const sha = shas.get(mark);
          if (sha === undefined) throw new GitError("git fast-import lost a blob", ["fast-import"]);
          return { mode, path, sha };
        }),
        unreadable: [...listing.closed, ...listing.paths.filter((p) => !kept.has(p))],
        skipped: listing.skipped,
      };
    } catch (err) {
      blobs.abort();
      if (err instanceof ArchiveTooLarge) throw new ArchiveTooLarge(listing.closed.length + listing.skipped);
      throw err;
    }
  });
}
