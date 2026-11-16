/**
 * The workspace's tree as the collection's confined reader sees it (ADR-130
 * §4.2, correction of 2026-11-16): the reader's listing and archive
 * (`engine/reader.ts`), judged by `workArchive.ts`, written as blobs into the
 * collection's own temporary repository by one `git fast-import` — bytes on
 * its stdin, never a path. The host opens nothing under `work/`.
 *
 * What it answers: the entries (a file `100644` or `100755` by its owner's
 * execute bit, a symbolic link `120000` whose blob is its target), and what
 * the reader could not read — a listed file the archive does not hold (a
 * `chmod 600` by the student, read as "other" by the reader's own user, or
 * one removed or swapped meanwhile), a directory git could not open, a name
 * that is not UTF-8 — which the collection takes from the commit that would
 * otherwise be graded (`withUnreadableKept`).
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";

import type { CollectionTreeEntry } from "@quiz/domain";

import type { WorkspaceReader } from "../engine/reader.js";
import { GitError, gitEnv } from "./gitRunner.js";
import { ArchiveTooLarge, readWorkArchive } from "./workArchive.js";

export interface WorkTree {
  entries: CollectionTreeEntry[];
  /** Files and directories not read (`""`: the work tree itself). */
  unreadable: string[];
  /** Names that are not UTF-8: neither read nor kept. */
  undecodable: number;
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
        undecodable: listing.undecodable,
      };
    } catch (err) {
      blobs.abort();
      if (err instanceof ArchiveTooLarge) throw new ArchiveTooLarge(listing.closed.length + listing.undecodable);
      throw err;
    }
  });
}
