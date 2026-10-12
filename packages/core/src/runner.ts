/**
 * The code runner, behind an interface (PLAN-MVP §1.7).
 *
 * `packages/core` owns the wire shapes; the implementations live in
 * `apps/api/src/modules/runner/` and are selected by `RUNNER_MODE`
 * (`stub` | `http` | `fake`). `stub` is the default everywhere until a machine
 * with Podman exists, so nothing in this repository needs a container engine
 * to be developed or tested.
 */
import { z } from "zod";

/**
 * The five programming languages of phase 1, and `spice`: the ngspice image
 * that serves the `circuit` question type. It is a "language" only in the
 * runner's eyes — one image, one run plan, the same hardened container.
 */
export const RunnerLanguage = z.enum(["c", "cpp", "python", "js", "rust", "spice"]);
export type RunnerLanguage = z.infer<typeof RunnerLanguage>;

export const RunnerRequest = z.object({
  language: RunnerLanguage,
  files: z
    .array(z.object({ name: z.string().max(64), content: z.string().max(200_000) }))
    .min(1)
    .max(8),
  compileArgs: z.string().max(400).default(""),
  action: z.enum(["check", "run"]),
  limits: z.object({
    timeMs: z.number().int().min(100).max(20_000),
    memoryMb: z.number().int().min(16).max(512),
    outputKb: z.number().int().min(1).max(256),
  }),
  cases: z
    .array(
      z.object({
        name: z.string(),
        /** `argv[1..]` of the program; the runner never builds a command line from it. */
        args: z.array(z.string().max(200)).max(32).default([]),
        stdin: z.string().max(64_000),
      }),
    )
    .max(50),
  /** "interactive" (student clicked Run) or "grading" (background). Maps to the runner's two queues. */
  priority: z.enum(["interactive", "grading"]).default("grading"),
  /**
   * The most this request may take once it runs, queue wait excluded, in ms
   * (ADR-101). The runner starts no case that could end past it and reports
   * the rest as timed out: an overrun is a result, never a dropped call. The
   * API sets it ({@link requestBudgetMs}, a Run click capped lower); absent,
   * the runner's own ceiling applies. Optional both ways: the API and the
   * runner deploy separately, and an older runner drops the field.
   */
  budgetMs: z.number().int().min(1000).max(600_000).optional(),
});
export type RunnerRequest = z.infer<typeof RunnerRequest>;

/** The four knobs of a request's budget; the runner reads them from its environment. */
export interface RunnerBudgetLimits {
  /** Ceiling on one case's `limits.timeMs` (`RUNNER_MAX_TIME_MS`). */
  maxTimeMs: number;
  /** Budget of the build step (`RUNNER_COMPILE_TIMEOUT_MS`). */
  compileTimeoutMs: number;
  /** Past a case's deadline, before the service destroys the container (`RUNNER_CASE_GRACE_MS`). */
  caseGraceMs: number;
  /** Ceiling on a whole request (`RUNNER_REQUEST_TIMEOUT_MS`). */
  requestTimeoutMs: number;
}

/**
 * The runner's defaults: `apps/runner/src/config.ts` defaults to these, and
 * the API budgets against them, so each value is written once. A runner
 * configured with higher ceilings still gets the API's budget (`budgetMs`).
 */
export const RUNNER_BUDGET_DEFAULTS: RunnerBudgetLimits = {
  maxTimeMs: 20_000,
  compileTimeoutMs: 20_000,
  caseGraceMs: 2_000,
  requestTimeoutMs: 120_000,
};

/** One upload or `podman exec` round trip, in the budget. */
const ROUND_TRIP_MS = 2000;

/**
 * Past a request's budget: the container's removal and the answer's way back.
 * The runner's container lives this long past the budget, and the API waits
 * this long past it too.
 */
export const RUNNER_TTL_SLACK_MS = 5000;

/**
 * The most a request may take once it runs, in ms: the build, then every
 * case at its full budget plus the grace, plus the uploads and the slack a
 * `podman exec` round trip costs; capped by the request ceiling and by the
 * request's own `budgetMs`. One formula for the container's lifetime (the
 * runner's `containerTtlSeconds`), the runner's case deadline and the API's
 * wait (ADR-101).
 */
export function requestBudgetMs(
  request: Pick<RunnerRequest, "action" | "cases" | "files" | "limits" | "budgetMs">,
  limits: RunnerBudgetLimits = RUNNER_BUDGET_DEFAULTS,
): number {
  const cases = request.action === "check" ? 0 : request.cases.length;
  const timeMs = Math.min(request.limits.timeMs, limits.maxTimeMs);
  const budget =
    limits.compileTimeoutMs +
    cases * (timeMs + limits.caseGraceMs) +
    (request.files.length + 2) * ROUND_TRIP_MS;
  return Math.min(budget, limits.requestTimeoutMs, request.budgetMs ?? Number.POSITIVE_INFINITY);
}

/** One case of a run, as the runner reports it. */
export const RunnerCase = z.object({
  /** The program's own exit code; null when it did not exit by itself (killed, oom). */
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  ms: z.number(),
  timedOut: z.boolean(),
  oom: z.boolean(),
  truncated: z.boolean(),
});
export type RunnerCase = z.infer<typeof RunnerCase>;

export const RunnerOutcome = z.object({
  compile: z.object({ ok: z.boolean(), stdout: z.string(), stderr: z.string(), ms: z.number() }),
  cases: z.array(RunnerCase),
});
export type RunnerOutcome = z.infer<typeof RunnerOutcome>;

/**
 * The answer of `POST /attempts/:id/simulate`: the student's own cases raw,
 * and what ran of the teacher's work reduced by the type in `reference`
 * (`QuestionTypeServer.interactiveOutcome`, ADR-019 §6 as amended 2026-10-11).
 */
export const InteractiveOutcome = RunnerOutcome.extend({
  reference: z.array(z.unknown()).optional(),
});
export type InteractiveOutcome = z.infer<typeof InteractiveOutcome>;

/**
 * What a run gives back to a player or an editor: the runner's outcome, or
 * why there is none — no engine answered (`unavailable`), or the caller's
 * run budget is spent (`rate_limited`, a 429 of the API).
 */
export type RunOutcome = RunnerOutcome | "unavailable" | "rate_limited";

/** {@link RunOutcome} of a Simulate button. */
export type SimulateOutcome = InteractiveOutcome | "unavailable" | "rate_limited";

export const RunnerHealth = z.object({
  ok: z.boolean(),
  /**
   * The languages this deployment has an image for — a subset of the enum
   * above, never a free string: a runner announcing something the platform has
   * no question type for is a runner the API should not believe.
   */
  languages: z.array(RunnerLanguage),
  queued: z.number().int(),
  avgMs: z.number().nullable(),
  reason: z.string().optional(),
  /**
   * The OCI runtime the sandbox containers run under — `runsc` is gVisor
   * (N-SEC-06, ADR-016) — for the system status. Optional on both sides: the
   * API and the runner deploy separately, and a runner older than the field,
   * or whose engine did not name its runtime, simply leaves it out.
   */
  runtime: z.string().optional(),
});
export type RunnerHealth = z.infer<typeof RunnerHealth>;

export interface RunnerService {
  /** Throws {@link RunnerUnavailable} when no engine is configured or healthy; throws {@link RunnerBusy} on 429. */
  run(req: RunnerRequest): Promise<RunnerOutcome>;
  health(): Promise<RunnerHealth>;
}

/*
 * Project runs (ADR-106 §3): a whole student repository, tested in the same
 * hardened container as a code question. ONE archive travels in on stdin and
 * is unpacked inside the container, every entry sanitized first; a fixed argv
 * builds then tests it, no shell; a capped list of text files comes back.
 */

/** The decoded archive's ceiling, in bytes. */
export const PROJECT_ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;
/** The longest base64 text that can decode to {@link PROJECT_ARCHIVE_MAX_BYTES}. */
export const PROJECT_ARCHIVE_MAX_BASE64 = Math.ceil(PROJECT_ARCHIVE_MAX_BYTES / 3) * 4;
/** One output file's ceiling, in bytes, and one step's per stream. */
export const PROJECT_FILE_MAX_BYTES = 256 * 1024;
/** The ceiling of all the output files of one run together, in bytes read. */
export const PROJECT_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
/** How many output paths a request may name. */
export const PROJECT_OUTPUTS_MAX = 16;
/**
 * The longest a project run may take once it runs: the ceiling of the
 * runner's `RUNNER_PROJECT_TIMEOUT_MS`, which the API's wait is built on.
 */
export const PROJECT_TIME_MAX_MS = 600_000;

/** The images a project may run in: `quiz-runner-lab-c` (gcc, make, python3, pytest). */
export const ProjectImage = z.enum(["lab-c"]);
export type ProjectImage = z.infer<typeof ProjectImage>;

/** One path segment's ceiling, in UTF-8 bytes (Linux's NAME_MAX). */
const SEGMENT_MAX_BYTES = 255;
/** A whole path's ceiling, in UTF-8 bytes (Linux's PATH_MAX). */
const PATH_MAX_BYTES = 4096;

const encoder = new TextEncoder();

/**
 * Why a path of a project — an archive entry, an output — is refused, or
 * `null` when it is a normalized relative path: no leading `/`, no `.` or
 * `..` segment, no empty segment (`a//b`), no control character, no segment
 * over 255 bytes. One trailing `/` is allowed: it names a directory. The
 * runner's sanitizer and the API share this rule; it never rewrites a path.
 */
export function projectPathProblem(path: string): string | null {
  const body = path.endsWith("/") ? path.slice(0, -1) : path;
  if (body === "") return "empty";
  if (encoder.encode(path).length > PATH_MAX_BYTES) return "too_long";
  // C0 controls and DEL: a name a terminal, a log line or a tar header could misread.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control_character";
  if (body.startsWith("/")) return "absolute";
  for (const segment of body.split("/")) {
    if (segment === "") return "empty_segment";
    if (segment === "." || segment === "..") return "dot_segment";
    if (encoder.encode(segment).length > SEGMENT_MAX_BYTES) return "segment_too_long";
  }
  return null;
}

/**
 * A command line as an argv: one element is ONE argument, verbatim; no shell
 * ever reads it. The program may not start with `-`, which `timeout` would
 * take for one of its own options.
 */
export const ProjectArgv = z
  .array(z.string().min(1).max(1024).refine((arg) => !arg.includes("\0"), "no NUL byte"))
  .min(1)
  .max(64)
  // zod runs a refinement even when `min` failed: an empty argv reaches it.
  .refine((argv) => !(argv[0] ?? "").startsWith("-"), "the program cannot start with '-'");
export type ProjectArgv = z.infer<typeof ProjectArgv>;

export const ProjectRunRequest = z.object({
  /** A tar archive, base64; its entries are sanitized by the runner, never trusted. */
  archive: z.string().min(1).max(PROJECT_ARCHIVE_MAX_BASE64),
  image: ProjectImage,
  /** `build` (optional) then `test`, ALWAYS: the tests run even when the build failed. */
  commands: z.object({ build: ProjectArgv.optional(), test: ProjectArgv }),
  /** Files or directories (trailing `/` or not) to bring back, relative to the root. */
  outputs: z
    .array(z.string().refine((path) => projectPathProblem(path) === null, "not a relative path"))
    .max(PROJECT_OUTPUTS_MAX),
  // No limits and no budget: the runner's configuration owns them (ADR-106
  // §3), never a request.
});
export type ProjectRunRequest = z.infer<typeof ProjectRunRequest>;

/** One step of a project run: the build or the tests. */
export const ProjectStep = z.object({
  /** null when it did not exit by itself (killed at its deadline, not started). */
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  ms: z.number(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
});
export type ProjectStep = z.infer<typeof ProjectStep>;

/**
 * An output file: its text (UTF-8, no NUL byte), or only its size when it is
 * not text. A file over its cap, or past the total, comes back empty and
 * `truncated`.
 */
export const ProjectOutputFile = z.union([
  z.object({ path: z.string(), content: z.string(), truncated: z.boolean(), size: z.number().int() }),
  z.object({ path: z.string(), binary: z.literal(true), size: z.number().int() }),
]);
export type ProjectOutputFile = z.infer<typeof ProjectOutputFile>;

export const ProjectRunResult = z.object({
  build: ProjectStep.nullable(),
  test: ProjectStep,
  files: z.array(ProjectOutputFile),
});
export type ProjectRunResult = z.infer<typeof ProjectRunResult>;

/**
 * A project run the runner refused for a reason no retry changes: no image
 * for it here, an archive not a tar, or holding an entry the sanitizer
 * refuses — then the WHOLE archive is refused (CLAUDE.md invariant 12) and
 * `entries` names them, `<path>: <reason>` — or one that does not fit the
 * work directory, or a request it would not parse (an archive over the cap
 * included).
 */
export const ProjectRunRefusal = z.object({
  refused: z.enum([
    "image_unavailable",
    /** Unpacked, it does not fit the runner's `RUNNER_PROJECT_WORKDIR_MB`. */
    "archive_too_large_for_workdir",
    "archive_invalid",
    "archive_refused",
    "invalid_request",
  ]),
  entries: z.array(z.string()).optional(),
});
export type ProjectRunRefusal = z.infer<typeof ProjectRunRefusal>;

/**
 * A runner that can test a whole repository. Separate from {@link RunnerService}
 * on purpose: only the API's runner implements it, not the many doubles of a
 * code question's runner.
 */
export interface ProjectRunnerService {
  /** Throws {@link RunnerUnavailable} or {@link RunnerBusy} like `run`; a refusal is an answer. */
  project(req: ProjectRunRequest): Promise<ProjectRunResult | ProjectRunRefusal>;
}
