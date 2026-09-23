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
});
export type RunnerRequest = z.infer<typeof RunnerRequest>;

export const RunnerOutcome = z.object({
  compile: z.object({ ok: z.boolean(), stdout: z.string(), stderr: z.string(), ms: z.number() }),
  cases: z.array(
    z.object({
      exitCode: z.number().int().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      ms: z.number(),
      timedOut: z.boolean(),
      oom: z.boolean(),
      truncated: z.boolean(),
    }),
  ),
});
export type RunnerOutcome = z.infer<typeof RunnerOutcome>;

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
});
export type RunnerHealth = z.infer<typeof RunnerHealth>;

export interface RunnerService {
  /** Throws {@link RunnerUnavailable} when no engine is configured or healthy; throws {@link RunnerBusy} on 429. */
  run(req: RunnerRequest): Promise<RunnerOutcome>;
  health(): Promise<RunnerHealth>;
}
