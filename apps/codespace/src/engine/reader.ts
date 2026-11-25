/**
 * The confined reader of a student's `work/` (the portal's invariant 15;
 * ADR-130, correction of 2026-11-16, gives the reason): a throwaway
 * container with the sessions' hardening (`hardeningArgs`), `--network
 * none`, no variable of ours and the volume read-only, in which two fixed
 * argv commands list the paths `git add -A` would add (`.gitignore`
 * honoured, a nested repository as `dir/`) and archive exactly those with
 * GNU tar. Both outputs go to the host as data (`git/workArchive.ts`).
 *
 * A fresh container rather than `podman exec` into the session's: a closed
 * session has none, and the student's processes do not share its limits.
 * It is no session (no session label: neither the listing, the
 * reconciliation nor the quota sees it); its only process sleeps for the
 * budget left and it runs `--rm`, so it goes on its own if the portal dies;
 * it is removed on every exit path and swept at startup. The image is the
 * platform's default (`CODESPACE_DEFAULT_IMAGE`, the current `quiz-base`,
 * never a course's: ADR-146 §3), which carries `/usr/bin/git`, GNU
 * `/usr/bin/tar` and `/usr/bin/sleep`; started `--pull=never`.
 *
 * The streaming exec and the label sweep live here rather than on
 * `Engine`: the session tests' fake engines implement `Engine` whole, and
 * the reader's injectable spawner is what its own tests drive.
 */
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { ArchiveTooLarge, workPathProblem, type WorkPathProblem } from "../git/workArchive.js";
import { COLLECTION_ENTRIES_MAX, LISTING_MAX_BYTES } from "../git/workTree.js";
import {
  OutputOverCap,
  ReaderError,
  ReaderTimeout,
  finish,
  helperArgs,
  helperName,
  removeHelper,
  runPodman,
  sweepHelpers,
  type PodmanRun,
  type SpawnPodman,
} from "./helper.js";
import { SESSION_USER, type Confinement, type EngineOptions, type Limits } from "./index.js";

export { ROLE_LABEL, ReaderError, ReaderTimeout, type SpawnPodman } from "./helper.js";
export const READER_ROLE = "reader";

/**
 * One reader per collection, 16 at most at once: 64 MiB each (1 GiB at a
 * deadline, page cache included, reclaimed under the limit) reads a 95 MiB
 * tree on a real engine (`reader.integration.test.ts`).
 */
export const READER_LIMITS: Limits = { pidsLimit: 32, memory: "64m", cpus: "1" };
/** The throwaway repository `ls-files` needs, and nothing else writable. */
export const READER_TMPFS = "/tmp:rw,nosuid,nodev,noexec,size=8m";

const LIST_GIT_DIR = "/tmp/list.git";
/** A throwaway repository for the listing: never the student's `.git`. */
export const READER_INIT = ["/usr/bin/git", "init", "--quiet", "--bare", LIST_GIT_DIR] as const;
/** What `git add -A` would add to an empty index: `.gitignore` honoured, `.git` never entered, a nested repository as `dir/`. */
export const READER_LIST = [
  "/usr/bin/git",
  "-c",
  "safe.directory=*",
  "-c",
  "core.excludesFile=/dev/null",
  `--git-dir=${LIST_GIT_DIR}`,
  "--work-tree=/work",
  "ls-files",
  "-z",
  "--others",
  "--exclude-standard",
] as const;
/** Exactly the listed paths (NUL-separated on stdin), links as links, hard links as files, unreadable files skipped. */
export const READER_ARCHIVE = [
  "/usr/bin/tar",
  "--create",
  "--file=-",
  "--directory=/work",
  "--format=gnu",
  "--numeric-owner",
  "--no-recursion",
  "--hard-dereference",
  "--ignore-failed-read",
  "--null",
  "--verbatim-files-from",
  "--no-unquote",
  "--files-from=-",
] as const;

/** The reader's image is the platform's default (`CODESPACE_DEFAULT_IMAGE`), never a course's. */
export type ReaderOptions = Confinement & Pick<EngineOptions, "podmanUrl" | "instance"> & { image: string };

/** `podman run` of a reader over `workDir`, living `lifetimeSeconds` at most. */
export function readerArgs(o: ReaderOptions, name: string, workDir: string, lifetimeSeconds: number): string[] {
  return helperArgs(o, {
    role: READER_ROLE,
    name,
    detach: true,
    rm: true,
    tmpfs: [READER_TMPFS],
    limits: READER_LIMITS,
    // Read-only, and never `:U`: the session's ownership of its volume stays as it is.
    tail: [
      "--user",
      SESSION_USER,
      "-v",
      `${workDir}:/work:ro,nosuid,nodev,noexec`,
      "--entrypoint",
      "/usr/bin/sleep",
      o.image,
      String(lifetimeSeconds),
    ],
  });
}

/** What the reader listed: the paths to archive, the directories it could not open, the names it leaves out. */
export interface WorkListing {
  paths: string[];
  /** Directories git could not open (never the work tree itself: that is a failed read). */
  closed: string[];
  /** Names left out: not UTF-8, a control character, over Linux's limits. */
  skipped: number;
}


const strict = new TextDecoder("utf-8", { fatal: true });
const CLOSED_LINE = "warning: could not open directory '";
const CLOSED = /^warning: could not open directory '(.*)': /;
/** What git never prints: a listing holding one is refused, not trimmed. Typed: a renamed reason is a compile error. */
const STRUCTURAL: ReadonlySet<WorkPathProblem> = new Set<WorkPathProblem>(["empty", "absolute", "empty_segment", "dot_segment", "git_segment"]);

/**
 * `ls-files -z`'s output and git's warnings, as data. A nested repository
 * (`dir/`) is left out, as the gitlink it was is; a name a path here cannot
 * carry (not UTF-8, a control character, too long) is counted, not kept; a
 * path no git prints, or a closed directory whose name cannot be read back,
 * refuses the listing — never a directory silently dropped. Past
 * `maxEntries` names (skipped ones included) it stops at once with
 * {@link ArchiveTooLarge}: the rest is never decoded.
 */
export function parseListing(stdout: Buffer, stderr: string, maxEntries = COLLECTION_ENTRIES_MAX): WorkListing {
  const listing: WorkListing = { paths: [], closed: [], skipped: 0 };
  let at = 0;
  while (at < stdout.length) {
    if (listing.paths.length + listing.skipped >= maxEntries) throw new ArchiveTooLarge(listing.skipped);
    const end = stdout.indexOf(0, at);
    if (end === -1) throw new ReaderError("the listing does not end with a NUL");
    const raw = stdout.subarray(at, end);
    at = end + 1;
    let path: string;
    try {
      path = strict.decode(raw);
    } catch {
      listing.skipped += 1;
      continue;
    }
    if (path.endsWith("/")) continue;
    const problem = workPathProblem(path);
    if (problem !== null && STRUCTURAL.has(problem)) throw new ReaderError(`the listing holds a path refused: ${problem}`);
    if (problem !== null) listing.skipped += 1;
    else listing.paths.push(path);
  }
  for (const line of stderr.split("\n")) {
    if (!line.startsWith(CLOSED_LINE)) continue;
    const dir = CLOSED.exec(line)?.[1]?.replace(/\/$/, "");
    if (dir === "" || dir === ".") throw new ReaderError("the reader cannot open the work tree itself");
    if (dir !== undefined && workPathProblem(dir) === null) listing.closed.push(dir);
    else throw new ReaderError("a directory the reader could not open has a name it cannot name back");
  }
  return listing;
}

export interface WorkspaceReader {
  /**
   * Lists and archives `workDir` in a fresh reader, hands both to `consume`,
   * and removes the reader whatever happens. Throws {@link ReaderTimeout}
   * past `timeoutMs`, {@link ReaderError} when the reader fails, or what
   * `consume` throws, or {@link ArchiveTooLarge} past `maxEntries` listed names.
   */
  read<T>(workDir: string, timeoutMs: number, consume: (listing: WorkListing, archive: Readable) => Promise<T>, maxEntries?: number): Promise<T>;
  /** Removes this instance's readers a crash left behind (startup only: none is in use then). */
  sweep(): Promise<number>;
  readerName(): string;
}

export function createWorkspaceReader(o: ReaderOptions, spawnPodman?: SpawnPodman): WorkspaceReader {
  const start: SpawnPodman =
    spawnPodman ?? ((args) => spawn("podman", ["--remote", "--url", o.podmanUrl, ...args], { stdio: "pipe" }));

  async function ok(args: string[], deadline: number, what: string, maxStdout?: number): Promise<PodmanRun> {
    const ran = await runPodman(start, args, deadline, maxStdout === undefined ? {} : { maxStdout });
    if (ran.code !== 0) throw new ReaderError(`${what} failed (${ran.code}): ${ran.stderr.slice(0, 400)}`);
    return ran;
  }

  const readerName = () => helperName(o.instance, READER_ROLE);

  return {
    readerName,

    async read<T>(
      workDir: string,
      timeoutMs: number,
      consume: (listing: WorkListing, archive: Readable) => Promise<T>,
      maxEntries = COLLECTION_ENTRIES_MAX,
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      const name = readerName();
      try {
        await ok(readerArgs(o, name, workDir, Math.max(1, Math.ceil(timeoutMs / 1000))), deadline, "starting the reader");
        await ok(["exec", name, ...READER_INIT], deadline, "the listing's repository");
        // A listing past its byte cap holds more than the entries' cap allows: too large, not a failure.
        const list = await ok(["exec", name, ...READER_LIST], deadline, "the listing", LISTING_MAX_BYTES).catch((err: unknown) => {
          throw err instanceof OutputOverCap ? new ArchiveTooLarge() : err;
        });
        // The closed directories are read from git's warnings: all of them, or no collection.
        if (list.stderrCut) throw new ReaderError("the listing's warnings are over their cap");
        const listing = parseListing(list.stdout, list.stderr, maxEntries);

        if (Date.now() >= deadline) throw new ReaderTimeout();
        const tar = start(["exec", "-i", name, ...READER_ARCHIVE]);
        tar.stdin.on("error", () => undefined);
        tar.stdin.end(Buffer.from(listing.paths.map((p) => `${p}\0`).join(""), "utf8"));
        const exited = finish(tar, deadline, 0, false);
        // A failed exec, or the deadline, ends the read even if `consume` is not reading.
        const broken = exited.then(() => new Promise<never>(() => undefined));
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ReaderTimeout()), Math.max(0, deadline - Date.now()));
        });
        let result: T;
        try {
          result = await Promise.race([consume(listing, tar.stdout), broken, late]);
        } catch (err) {
          tar.kill("SIGKILL");
          tar.stdout.destroy();
          // Killed for the time: the archive's truncation is the timeout's.
          await exited.catch((e: unknown) => {
            if (e instanceof ReaderTimeout) throw e;
          });
          throw err;
        } finally {
          clearTimeout(timer);
        }
        const ran = await exited;
        // GNU tar: 1 is "a file changed as it was read", still a whole archive.
        if (ran.code !== 0 && ran.code !== 1) throw new ReaderError(`the archive failed (${ran.code}): ${ran.stderr.slice(0, 400)}`);
        return result;
      } finally {
        await removeHelper(start, name);
      }
    },

    sweep: () => sweepHelpers(start, o.instance, READER_ROLE),
  };
}
