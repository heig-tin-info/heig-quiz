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
 * it is removed on every exit path and swept at startup. The image is
 * `CODESPACE_IMAGE`, which carries `/usr/bin/git`, GNU `/usr/bin/tar` and
 * `/usr/bin/sleep`.
 *
 * The streaming exec and the label sweep live here rather than on
 * `Engine`: the session tests' fake engines implement `Engine` whole, and
 * the reader's injectable spawner is what its own tests drive.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import { ArchiveTooLarge, workPathProblem, type WorkPathProblem } from "../git/workArchive.js";
import { COLLECTION_ENTRIES_MAX, LISTING_MAX_BYTES } from "../git/workTree.js";
import { INSTANCE_LABEL, hardeningArgs, type Confinement, type EngineOptions, type Limits } from "./index.js";

/** The role label of the portal's helpers: never `SESSION_LABEL`. */
export const ROLE_LABEL = "heig-codespace.role";
export const READER_ROLE = "reader";

/**
 * One reader per collection, 16 at most at once: 64 MiB each (1 GiB at a
 * deadline, page cache included, reclaimed under the limit) reads a 95 MiB
 * tree on a real engine (`reader.integration.test.ts`).
 */
export const READER_LIMITS: Limits = { pidsLimit: 32, memory: "64m", cpus: "1" };
/** The throwaway repository `ls-files` needs, and nothing else writable. */
export const READER_TMPFS = "/tmp:rw,nosuid,nodev,noexec,size=8m";
/** The image's own unprivileged user, said explicitly. */
export const READER_USER = "1000:1000";

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

/** What a command other than the listing may print (a container id, a name). */
const OUTPUT_MAX_BYTES = 64 * 1024;
/** Removal runs whatever the budget says. */
const REMOVE_TIMEOUT_MS = 15_000;

export type ReaderOptions = Confinement & Pick<EngineOptions, "podmanUrl" | "instance" | "image">;

/** `podman run` of a reader over `workDir`, living `lifetimeSeconds` at most. */
export function readerArgs(o: ReaderOptions, name: string, workDir: string, lifetimeSeconds: number): string[] {
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    `${ROLE_LABEL}=${READER_ROLE}`,
    "--label",
    `${INSTANCE_LABEL}=${o.instance}`,
    ...hardeningArgs(o, [READER_TMPFS], READER_LIMITS),
    "--network",
    "none",
    "--user",
    READER_USER,
    // Read-only, and never `:U`: the session's ownership of its volume stays as it is.
    "-v",
    `${workDir}:/work:ro,nosuid,nodev,noexec`,
    "--entrypoint",
    "/usr/bin/sleep",
    o.image,
    String(lifetimeSeconds),
  ];
}

/** What the reader listed: the paths to archive, the directories it could not open, the names it leaves out. */
export interface WorkListing {
  paths: string[];
  /** Directories git could not open (never the work tree itself: that is a failed read). */
  closed: string[];
  /** Names left out: not UTF-8, a control character, over Linux's limits. */
  skipped: number;
}

/** The reader could not run, or answered something it never would. */
export class ReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReaderError";
  }
}

/** A command printed more than its cap. */
class OutputOverCap extends ReaderError {
  constructor() {
    super("the reader's output is over its cap");
  }
}

/** The time given ran out. */
export class ReaderTimeout extends Error {
  constructor() {
    super("the confined reader ran out of time");
    this.name = "ReaderTimeout";
  }
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

/** Starts `podman --remote …`; injectable so that the tests drive a fake engine. */
export type SpawnPodman = (args: string[]) => ChildProcessWithoutNullStreams;

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

interface Ran {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** stderr went past what is kept: a list read from it would be incomplete. */
  stderrCut: boolean;
}

/** What is kept of a reader's stderr. */
const STDERR_MAX = 64 * 1024;

/** Waits for `child`, collecting its output, killed past `deadline` (then {@link ReaderTimeout}). */
function finish(child: ChildProcessWithoutNullStreams, deadline: number, maxStdout: number, collect = true): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    let stderrCut = false;
    let failure: Error | null = null;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const stop = (e: Error) => {
      failure ??= e;
      child.kill("SIGKILL");
      // Output nobody reads would hold `close` back.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => stop(new ReaderTimeout()), Math.max(0, deadline - Date.now()));
    if (collect) {
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxStdout) stop(new OutputOverCap());
        else out.push(chunk);
      });
    }
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length + chunk.length <= STDERR_MAX) err += chunk.toString("utf8");
      else stderrCut = true;
    });
    // A podman that cannot even start (no binary): its own error, at once.
    child.on("error", (e) => settle(() => reject(failure ?? new ReaderError(e.message))));
    child.on("close", (code) => settle(() => (failure ? reject(failure) : resolve({ code, stdout: Buffer.concat(out), stderr: err, stderrCut }))));
  });
}

export function createWorkspaceReader(o: ReaderOptions, spawnPodman?: SpawnPodman): WorkspaceReader {
  const start: SpawnPodman =
    spawnPodman ?? ((args) => spawn("podman", ["--remote", "--url", o.podmanUrl, ...args], { stdio: "pipe" }));

  async function podman(args: string[], deadline: number, maxStdout = OUTPUT_MAX_BYTES): Promise<Ran> {
    if (Date.now() >= deadline) throw new ReaderTimeout();
    const child = start(args);
    child.stdin.on("error", () => undefined);
    child.stdin.end();
    return finish(child, deadline, maxStdout);
  }

  async function ok(args: string[], deadline: number, what: string, maxStdout?: number): Promise<Ran> {
    const ran = await podman(args, deadline, maxStdout);
    if (ran.code !== 0) throw new ReaderError(`${what} failed (${ran.code}): ${ran.stderr.slice(0, 400)}`);
    return ran;
  }

  const readerName = () => `cs-${o.instance}-reader-${randomUUID()}`;

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
        await podman(["rm", "-f", "-t", "0", name], Date.now() + REMOVE_TIMEOUT_MS).catch(() => undefined);
      }
    },

    async sweep() {
      const listed = await ok(
        ["ps", "--all", "--filter", `label=${ROLE_LABEL}=${READER_ROLE}`, "--filter", `label=${INSTANCE_LABEL}=${o.instance}`, "--format", "{{.Names}}"],
        Date.now() + REMOVE_TIMEOUT_MS,
        "listing the readers",
      );
      const names = listed.stdout.toString("utf8").split("\n").map((n) => n.trim()).filter((n) => n.startsWith(`cs-${o.instance}-reader-`));
      for (const name of names) await podman(["rm", "-f", "-t", "0", name], Date.now() + REMOVE_TIMEOUT_MS).catch(() => undefined);
      return names.length;
    },
  };
}
