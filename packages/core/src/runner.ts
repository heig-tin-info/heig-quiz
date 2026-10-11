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
