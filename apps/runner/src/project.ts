import {
  PROJECT_FILE_MAX_BYTES,
  PROJECT_OUTPUT_MAX_BYTES,
  projectPathProblem,
  type ProjectOutputFile,
  type ProjectRunRequest,
  type ProjectRunResult,
  type ProjectStep,
} from "@quiz/core/server";
import { readTar, sanitizeArchive, TarError } from "@quiz/core/tar";

import { ExecuteError, runArgv, ttlSeconds, withContainer, type ExecuteDeps } from "./execute.js";
import { imageRef } from "./images.js";

/**
 * A project run (`POST /project`, ADR-106 §3): a whole student repository in
 * ONE container of `containerArgs()` — the flags of a code question's, none
 * added, none relaxed.
 *
 *  1. The archive is decoded and sanitized HERE, before it takes a slot
 *     (`prepareProject`, `@quiz/core/tar`): one entry that is not a regular
 *     file or a directory at a normalized relative path refuses the WHOLE
 *     archive (invariant 12); an accepted one is repacked into a clean tar.
 *  2. That tar travels in on `podman exec`'s stdin to GNU tar in `/work`, a
 *     tmpfs. Nothing from the host is mounted, and no path of the request
 *     ever becomes a path of the host.
 *  3. The build argv (if any), then the test argv — ALWAYS, even when the
 *     build failed, as the course's own workflow does — each under both
 *     clocks (`runArgv`), no shell. Every process left behind is killed
 *     after each step.
 *  4. The outputs: their parents checked without following a link, the
 *     regular files listed with `find -printf`, read back with ONE `tar -c`.
 */

/** The archive could not be accepted: a client fault, never retried. */
export class ProjectArchiveError extends Error {
  constructor(
    readonly reason: "archive_invalid" | "archive_refused",
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
  tar: Uint8Array;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes and sanitizes the archive; throws {@link ProjectArchiveError}. */
export function prepareProject(request: ProjectRunRequest): PreparedProject {
  if (request.archive.length % 4 !== 0 || !BASE64.test(request.archive)) {
    throw new ProjectArchiveError("archive_invalid");
  }
  let clean;
  try {
    clean = sanitizeArchive(Buffer.from(request.archive, "base64"));
  } catch (error) {
    if (error instanceof TarError) throw new ProjectArchiveError("archive_invalid");
    throw error;
  }
  if (clean.refused.length > 0) throw new ProjectArchiveError("archive_refused", clean.refused);
  return { request, tar: clean.tar };
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
/** The `find` listings' ceiling, in bytes. */
const LISTING_MAX_BYTES = 1024 * 1024;

/** A step that never ran: the budget was spent, or the container was lost. */
function notRun(): ProjectStep {
  return { exitCode: null, stdout: "", stderr: "", ms: 0, timedOut: true, truncated: false };
}

export async function runProject(
  prepared: PreparedProject,
  deps: ExecuteDeps,
): Promise<ProjectRunResult> {
  const { engine, config } = deps;
  const { request } = prepared;
  // The budget is the runner's, never the request's (ADR-106 §3).
  const budget = config.RUNNER_PROJECT_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  const create = {
    image: imageRef(config, request.image),
    memoryMb: config.RUNNER_MAX_MEMORY_MB,
    pidsLimit: 64,
    cpus: 1,
    workdirMb: config.RUNNER_PROJECT_WORKDIR_MB,
    ttlSeconds: ttlSeconds(budget),
  };

  return withContainer(deps, create, async ({ name, stopIfAborted }) => {
    const unpacked = await engine.exec(name, {
      argv: UNPACK_ARGV,
      stdin: prepared.tar,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      maxBytes: 16 * 1024,
    });
    if (unpacked.timedOut || unpacked.containerGone) {
      throw new ExecuteError("could not unpack the archive", "upload_failed");
    }
    // The archive is clean (this service wrote it): GNU tar failing on it is
    // the tmpfs running out — the same answer on every retry, so a refusal.
    if (unpacked.exitCode !== 0) {
      // GNU tar's own stderr goes to the log: a failure that is not ENOSPC
      // stays diagnosable. Nothing of the student's has run yet.
      throw new ExecuteError(
        "the archive does not fit the work directory",
        "archive_too_large_for_workdir",
        unpacked.stderr,
      );
    }

    let alive = true;
    /**
     * Whether the leftovers were reaped. A reap that throws or never answers
     * ends the run like a lost container — no later step, no outputs — and
     * never becomes an engine error of the whole run.
     */
    const reap = async (): Promise<boolean> => {
      try {
        const reaped = await engine.exec(name, { argv: REAP_ARGV, stdin: "", timeoutMs: 10_000, maxBytes: 4096 });
        return !reaped.timedOut && !reaped.containerGone;
      } catch {
        return false;
      }
    };
    /** One step, at most `ceilingMs`, and never past what the budget keeps for the outputs. */
    const step = async (argv: string[], ceilingMs: number): Promise<ProjectStep> => {
      stopIfAborted();
      const room = deadline - Date.now() - COLLECT_RESERVE_MS - config.RUNNER_CASE_GRACE_MS;
      const timeMs = Math.floor(Math.min(ceilingMs, room) / 1000) * 1000;
      if (!alive || timeMs < 1000) return notRun();
      const { lost, oom: _oom, ...result } = await runArgv(engine, name, {
        argv,
        stdin: "",
        timeMs,
        maxBytes: PROJECT_FILE_MAX_BYTES,
        graceMs: config.RUNNER_CASE_GRACE_MS,
      });
      if (lost || !(await reap())) alive = false;
      return result;
    };

    // The build gets at most half the budget, as a rule; the tests the rest.
    const build = request.commands.build === undefined ? null : await step(request.commands.build, budget / 2);
    const test = await step(request.commands.test, budget);
    stopIfAborted();
    const files =
      alive && request.outputs.length > 0 && Date.now() < deadline
        ? await collectOutputs(deps, name, request.outputs, deadline)
        : [];
    return { build, test, files };
  });
}

/** `a/b/c` → `["a", "a/b"]`: the directories an output path goes through. */
export function parentsOf(output: string): string[] {
  const segments = output.replace(/\/$/, "").split("/");
  return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"));
}

/** `find -printf '%y … %p\0'` records: the type letter and the path, `./` dropped. */
function records(listing: Uint8Array): Array<{ type: string; size: number; path: string }> {
  const out = [];
  for (const record of new TextDecoder().decode(listing).split("\0")) {
    const match = /^(\S) (?:(\d+) )?(.*)$/s.exec(record);
    if (match === null) continue;
    out.push({ type: match[1]!, size: Number(match[2] ?? 0), path: match[3]!.replace(/^\.\//, "") });
  }
  return out;
}

/**
 * The outputs whose every parent is a real directory, from the listing of
 * `find <parents> -maxdepth 0 -printf '%y %p\0'`. `find -P` refuses to
 * follow a symbolic link only as the LAST component of a starting point: a
 * parent the build replaced by a link (`out` -> `/` for `out/report.xml`)
 * would still be resolved. So an output with a parent not listed as `d` is
 * dropped (invariant 12: on the way out, a link is never followed).
 */
export function outputsUnderDirectories(outputs: readonly string[], listing: Uint8Array): string[] {
  const directories = new Set(records(listing).filter((r) => r.type === "d").map((r) => r.path));
  return outputs.filter((output) => parentsOf(output).every((parent) => directories.has(parent)));
}

/**
 * The regular files under the output paths, in the order of `outputs`, then
 * by path within one; each once. Only `f` passes: a symbolic link is neither
 * followed (`find -P`) nor returned; a name the path rule refuses is skipped.
 */
export function parseListing(listing: Uint8Array, outputs: readonly string[]): Array<{ path: string; size: number }> {
  const files = records(listing).filter(
    (r) => r.type === "f" && projectPathProblem(r.path) === null && !r.path.endsWith("/"),
  );
  const seen = new Set<string>();
  const ordered = [];
  for (const output of outputs) {
    const root = output.replace(/\/$/, "");
    const under = files
      .filter((file) => file.path === root || file.path.startsWith(`${root}/`))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const { path, size } of under) {
      if (seen.has(path)) continue;
      seen.add(path);
      ordered.push({ path, size });
    }
  }
  return ordered;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** A file read whole: its text, or only its size when it holds a NUL byte or is not UTF-8. */
export function outputFile(path: string, bytes: Uint8Array): ProjectOutputFile {
  const size = bytes.length;
  if (bytes.includes(0)) return { path, binary: true, size };
  try {
    return { path, content: strictUtf8.decode(bytes), truncated: false, size };
  } catch {
    return { path, binary: true, size };
  }
}

/**
 * Reads the output files back under the caps, every read bounded by the
 * deadline. A file is read whole or not at all: one over
 * `PROJECT_FILE_MAX_BYTES`, or past the `PROJECT_OUTPUT_MAX_BYTES` read in
 * the order of `outputs` (so `report.xml` listed first is read first), comes
 * back empty and truncated, with its size.
 */
async function collectOutputs(
  deps: ExecuteDeps,
  name: string,
  requested: readonly string[],
  deadline: number,
): Promise<ProjectOutputFile[]> {
  const { engine } = deps;
  const left = (): number => Math.max(1000, deadline - Date.now());
  // `./` before every path: never an option or an expression of find or tar.
  const dotted = (path: string): string => `./${path.replace(/\/$/, "")}`;

  // The parents first, links not followed (`outputsUnderDirectories`). Every
  // process of the container is dead (reaped), so none can swap a parent
  // between this check and the reads below.
  const parents = [...new Set(requested.flatMap(parentsOf))];
  let outputs = [...requested];
  if (parents.length > 0) {
    const checked = await engine.exec(name, {
      argv: ["find", ...parents.map(dotted), "-maxdepth", "0", "-printf", "%y %p\\0"],
      stdin: "",
      timeoutMs: left(),
      maxBytes: LISTING_MAX_BYTES,
    });
    outputs = outputsUnderDirectories(requested, checked.stdoutBytes);
  }
  if (outputs.length === 0) return [];

  const listing = await engine.exec(name, {
    argv: ["find", ...outputs.map(dotted), "-printf", "%y %s %p\\0"],
    stdin: "",
    timeoutMs: left(),
    maxBytes: LISTING_MAX_BYTES,
  });

  let remaining = PROJECT_OUTPUT_MAX_BYTES;
  const plan = parseListing(listing.stdoutBytes, outputs).map((file) => {
    const read = file.size <= PROJECT_FILE_MAX_BYTES && file.size <= remaining;
    if (read) remaining -= file.size;
    return { ...file, read };
  });

  const read = plan.filter((file) => file.read);
  const contents = new Map<string, Uint8Array>();
  if (read.length > 0 && Date.now() < deadline) {
    const archived = await engine.exec(name, {
      // `tar -c` never follows a link, and `--no-recursion` reads only these files.
      argv: ["tar", "-c", "-f", "-", "--no-recursion", ...read.map((file) => dotted(file.path))],
      stdin: "",
      timeoutMs: left(),
      // Each file's blocks and up to three header blocks (a GNU long name), the end.
      maxBytes: read.reduce((sum, file) => sum + Math.ceil(file.size / 512) * 512 + 1536, 20_480),
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

  return plan.map((file) => {
    const bytes = file.read ? contents.get(file.path) : undefined;
    return bytes === undefined
      ? { path: file.path, content: "", truncated: true, size: file.size }
      : outputFile(file.path, bytes);
  });
}
