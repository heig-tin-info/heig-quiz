import { randomUUID } from "node:crypto";

import {
  PROJECT_ARCHIVE_MAX_BYTES,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_OUTPUT_MAX_BYTES,
  RUNNER_TTL_SLACK_MS,
  projectPathProblem,
  type ProjectOutputFile,
  type ProjectRunRequest,
  type ProjectRunResult,
  type ProjectStep,
} from "@quiz/core/server";

import type { RunnerConfig } from "./config.js";
import { caseArgv, classify, ExecuteError, type ExecuteDeps } from "./execute.js";
import { imageRef } from "./images.js";
import { readTar, sanitizeArchive, TarError } from "./tar.js";

/**
 * A project run (`POST /project`, ADR-106 §3): a whole student repository in
 * ONE container of `containerArgs()` — the flags of a code question's, none
 * added, none relaxed.
 *
 *  1. The archive is decoded and sanitized HERE, before it takes a slot
 *     (`prepareProject`, `tar.ts`): one entry that is not a regular file or
 *     a directory at a normalized relative path refuses the WHOLE archive
 *     (invariant 12); an accepted one is repacked, entry by entry, into a
 *     clean tar.
 *  2. That tar travels in on `podman exec`'s stdin to GNU tar in `/work`, a
 *     tmpfs. Nothing from the host is mounted, and no path of the request
 *     ever becomes a path of the host (invariant 12).
 *  3. The build argv (if any), then the test argv — ALWAYS, even when the
 *     build failed, as the course's own workflow does — each under
 *     `timeout -s KILL` and the service's clock, no shell. Every process left
 *     behind is killed after each step.
 *  4. The output paths are listed with `find -printf` and read back with ONE
 *     `tar -c` (a file over its cap through `head -c`), under the caps.
 */

/** The archive could not be accepted: a client fault, never retried. */
export class ProjectArchiveError extends Error {
  constructor(
    readonly reason: "archive_too_large" | "archive_invalid" | "archive_refused",
    /** For `archive_refused`: the entries refused, `<path>: <reason>`. */
    readonly entries: string[] = [],
  ) {
    super(reason);
    this.name = "ProjectArchiveError";
  }
}

export interface PreparedProject {
  request: ProjectRunRequest;
  /** The clean archive: what the container's tar unpacks. */
  tar: Buffer;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes and sanitizes the archive; throws {@link ProjectArchiveError}. */
export function prepareProject(request: ProjectRunRequest): PreparedProject {
  if (request.archive.length % 4 !== 0 || !BASE64.test(request.archive)) {
    throw new ProjectArchiveError("archive_invalid");
  }
  const bytes = Buffer.from(request.archive, "base64");
  if (bytes.length > PROJECT_ARCHIVE_MAX_BYTES) throw new ProjectArchiveError("archive_too_large");
  let clean;
  try {
    clean = sanitizeArchive(bytes);
  } catch (error) {
    if (error instanceof TarError) throw new ProjectArchiveError("archive_invalid");
    throw error;
  }
  if (clean.refused.length > 0) throw new ProjectArchiveError("archive_refused", clean.refused);
  return { request, tar: clean.tar };
}

/** The run's budget on this deployment: the request's, capped by `RUNNER_PROJECT_TIMEOUT_MS`. */
export function projectBudgetMs(request: ProjectRunRequest, config: RunnerConfig): number {
  return Math.min(request.budgetMs, config.RUNNER_PROJECT_TIMEOUT_MS);
}

/**
 * GNU tar, reading the clean archive on stdin into `/work`: the files belong
 * to the container's user, their modes pass through its umask, and `/work`
 * itself keeps its own.
 */
export const UNPACK_ARGV = [
  "tar", "-x", "-f", "-", "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir",
];

/** Kills every process of the container but its `sleep` (pid 1, which `kill -1` never reaches). */
export const REAP_ARGV = ["kill", "-9", "-1"];

/** Kept for the outputs at the end of the budget: a step does not start past it. */
export const COLLECT_RESERVE_MS = 10_000;

const UPLOAD_TIMEOUT_MS = 60_000;
const SMALL_EXEC_MS = 30_000;
/** The `find` listing's ceiling, in bytes. */
const LISTING_MAX_BYTES = 1024 * 1024;

/** A step that never ran: the budget was spent, or the container was gone. */
function notRun(): ProjectStep {
  return { exitCode: null, stdout: "", stderr: "", ms: 0, timedOut: true, truncated: false };
}

export async function runProject(
  prepared: PreparedProject,
  deps: ExecuteDeps,
): Promise<ProjectRunResult> {
  const { engine, config, signal } = deps;
  const { request } = prepared;
  const budget = projectBudgetMs(request, config);
  const deadline = Date.now() + budget;
  const name = (deps.containerName ?? (() => `quiz-run-${randomUUID()}`))();
  const create = {
    name,
    image: imageRef(config, request.image),
    memoryMb: Math.min(request.limits.memoryMb, config.RUNNER_MAX_MEMORY_MB),
    pidsLimit: 64,
    cpus: Math.min(request.limits.cpus, config.RUNNER_PROJECT_MAX_CPUS),
    workdirMb: config.RUNNER_PROJECT_WORKDIR_MB,
    ttlSeconds: Math.ceil((budget + RUNNER_TTL_SLACK_MS) / 1000),
  };

  const stopIfAborted = (): void => {
    if (signal?.aborted) throw new ExecuteError("the caller has gone", "aborted");
  };
  const onAbort = (): void => void engine.remove(name).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    stopIfAborted();
    await engine.create(create);
    stopIfAborted();
    const unpacked = await engine.exec(name, {
      argv: UNPACK_ARGV,
      stdin: prepared.tar,
      timeoutMs: Math.max(1000, Math.min(UPLOAD_TIMEOUT_MS, deadline - Date.now())),
      maxBytes: 16 * 1024,
    });
    if (unpacked.exitCode !== 0) {
      throw new ExecuteError("could not unpack the archive", "upload_failed");
    }

    let alive = true;
    const step = async (argv: string[]): Promise<ProjectStep> => {
      stopIfAborted();
      const room = deadline - Date.now() - COLLECT_RESERVE_MS - config.RUNNER_CASE_GRACE_MS;
      const stepMs = Math.min(request.limits.timeMs, config.RUNNER_PROJECT_TIMEOUT_MS, room);
      if (!alive || stepMs < 1000) return notRun();
      const seconds = Math.floor(stepMs / 1000);
      const result = await engine.exec(name, {
        argv: caseArgv(argv, seconds, []),
        stdin: "",
        timeoutMs: seconds * 1000 + config.RUNNER_CASE_GRACE_MS,
        maxBytes: PROJECT_FILE_MAX_BYTES,
      });
      const verdict = classify(result, seconds * 1000);
      // The service's clock fired or the container died: it is not to be
      // trusted, and what is in its tmpfs is gone. No later step, no outputs.
      if (result.timedOut || result.containerGone) alive = false;
      else await reap();
      return {
        exitCode: verdict.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ms: result.ms,
        timedOut: verdict.timedOut,
        truncated: result.truncated,
      };
    };
    const reap = async (): Promise<void> => {
      await engine.exec(name, { argv: REAP_ARGV, stdin: "", timeoutMs: 10_000, maxBytes: 4096 });
    };

    const build = request.commands.build === undefined ? null : await step(request.commands.build);
    const test = await step(request.commands.test);
    stopIfAborted();
    const files =
      alive && request.outputs.length > 0 && Date.now() < deadline
        ? await collectOutputs(deps, name, request.outputs)
        : [];
    return { build, test, files };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await engine.remove(name).catch(() => undefined);
  }
}

/** One regular file of the listing. */
interface Listed {
  path: string;
  size: number;
}

/**
 * The regular files under the output paths, in the order of `outputs`, then
 * by path within one; each once. A symbolic link is not followed nor
 * returned; a name the path rule refuses is skipped.
 */
export function parseListing(stdout: Buffer, outputs: readonly string[]): Listed[] {
  const files: Listed[] = [];
  for (const record of stdout.toString("utf8").split("\0")) {
    const match = /^(\S) (\d+) (.*)$/s.exec(record);
    if (match === null || match[1] !== "f") continue;
    const path = match[3]!.replace(/^\.\//, "");
    if (projectPathProblem(path) !== null || path.endsWith("/")) continue;
    files.push({ path, size: Number(match[2]) });
  }
  const seen = new Set<string>();
  const ordered: Listed[] = [];
  for (const output of outputs) {
    const root = output.replace(/\/$/, "");
    const under = files
      .filter((file) => file.path === root || file.path.startsWith(`${root}/`))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const file of under) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      ordered.push(file);
    }
  }
  return ordered;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A file as it comes back: its text, or only its size when it holds a NUL
 * byte or is not UTF-8. A truncated file may end inside a character: up to
 * three trailing bytes are dropped before it is judged.
 */
export function outputFile(
  path: string,
  bytes: Buffer,
  size: number,
  truncated: boolean,
): ProjectOutputFile {
  if (bytes.includes(0)) return { path, binary: true, size };
  for (let cut = 0; cut <= (truncated ? 3 : 0) && cut <= bytes.length; cut += 1) {
    try {
      return { path, content: strictUtf8.decode(bytes.subarray(0, bytes.length - cut)), truncated };
    } catch {
      // try one byte shorter
    }
  }
  return { path, binary: true, size };
}

/**
 * Reads the output files back under the caps: each file at most
 * `PROJECT_FILE_MAX_BYTES`, all of them at most `PROJECT_OUTPUT_MAX_BYTES`
 * read, in the order of `outputs` (so `report.xml` first is read first). A
 * file past the total comes back empty and truncated.
 */
async function collectOutputs(
  deps: ExecuteDeps,
  name: string,
  outputs: readonly string[],
): Promise<ProjectOutputFile[]> {
  const { engine } = deps;
  // `./` first: a path is never read as an option or an expression of find.
  const roots = outputs.map((output) => `./${output.replace(/\/$/, "")}`);
  const listing = await engine.exec(name, {
    argv: ["find", ...roots, "-printf", "%y %s %p\\0"],
    stdin: "",
    timeoutMs: SMALL_EXEC_MS,
    maxBytes: LISTING_MAX_BYTES,
  });
  const listed = parseListing(listing.stdoutBytes, outputs);

  let remaining = PROJECT_OUTPUT_MAX_BYTES;
  const plan = listed.map((file) => {
    const take = Math.min(file.size, PROJECT_FILE_MAX_BYTES, remaining);
    remaining -= take;
    return { ...file, take };
  });

  const whole = plan.filter((file) => file.take === file.size);
  const contents = new Map<string, Buffer>();
  if (whole.length > 0) {
    const archived = await engine.exec(name, {
      argv: ["tar", "-c", "-f", "-", "--no-recursion", ...whole.map((file) => `./${file.path}`)],
      stdin: "",
      timeoutMs: SMALL_EXEC_MS,
      // Each file's blocks and up to three header blocks (a GNU long name), the end.
      maxBytes: whole.reduce((sum, file) => sum + Math.ceil(file.size / 512) * 512 + 1536, 20_480),
    });
    try {
      for (const entry of readTar(archived.stdoutBytes)) {
        if (entry.typeflag === "0" || entry.typeflag === "\0") {
          contents.set(entry.path.replace(/^\.\//, ""), entry.data);
        }
      }
    } catch (error) {
      // A cut archive leaves those files empty and truncated, below.
      if (!(error instanceof TarError)) throw error;
    }
  }

  const files: ProjectOutputFile[] = [];
  for (const file of plan) {
    if (file.take === file.size) {
      const bytes = contents.get(file.path);
      files.push(
        bytes === undefined
          ? { path: file.path, content: "", truncated: true }
          : outputFile(file.path, bytes, file.size, false),
      );
    } else if (file.take === 0) {
      files.push({ path: file.path, content: "", truncated: true });
    } else {
      const head = await engine.exec(name, {
        argv: ["head", "-c", String(file.take), `./${file.path}`],
        stdin: "",
        timeoutMs: SMALL_EXEC_MS,
        maxBytes: file.take,
      });
      files.push(outputFile(file.path, head.stdoutBytes, file.size, true));
    }
  }
  return files;
}
