import { randomUUID } from "node:crypto";

import {
  RUNNER_TTL_SLACK_MS,
  requestBudgetMs,
  type RunnerOutcome,
  type RunnerRequest,
} from "@quiz/core/server";

import type { RunnerConfig } from "./config.js";
import type { CreateOptions, Engine, ExecResult } from "./engine.js";
import { imageRef } from "./images.js";
import { planFor, sanitizeFileName, splitCompileArgs, type LanguagePlan } from "./languages.js";

/**
 * One request, one container.
 *
 * The container is created hardened (engine.ts), the sources travel in through
 * `podman exec` on stdin — nothing from the host is mounted, ever — the
 * language's build step runs once, then every case runs in turn with its own
 * stdin and its own wall clock. The container is destroyed in a `finally`,
 * whatever happened.
 *
 * Two clocks guard a case: `timeout -s KILL` inside the container, which is
 * the one that normally fires, and the service's own deadline
 * (`timeMs + RUNNER_CASE_GRACE_MS`), which destroys the container when the
 * first one did not. The second is the one the invariant is about: the wall
 * clock belongs to the service, never to the sandbox.
 *
 * `ms` is measured around the `podman exec` call, so it carries a few tens of
 * milliseconds of engine overhead. `finalizeRunnerCode` compares it against
 * the case's own budget, which is why a per-case budget below ~200 ms is not
 * a useful thing for a teacher to write (apps/runner/README.md).
 */

/**
 * The argv of one case: the in-container reaper, then the language's run
 * plan, then the case's own arguments.
 *
 * Every element is ONE argv entry and travels verbatim. No shell runs in a
 * container of this service, so a space, a quote, a `$` or a `;` inside an
 * argument is a character of that argument and nothing else — there is no
 * command line for it to escape from (`languages.ts`). A `timeout` that fires
 * therefore kills the program and not a shell that outlives it.
 */
export function caseArgv(
  run: readonly string[],
  seconds: number,
  args: readonly string[],
): string[] {
  return ["timeout", "-s", "KILL", String(seconds), ...run, ...args];
}

export class ExecuteError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    /** The service's own diagnostic (a tool's stderr), for the log only, never a student's output. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ExecuteError";
  }
}

export interface ExecuteDeps {
  engine: Engine;
  config: RunnerConfig;
  /** Injected by the tests; production uses a random name per request. */
  containerName?: () => string;
  /**
   * Aborts when the caller has gone: the container is destroyed at once —
   * the same `remove` that ends a case past its deadline — and no further
   * step starts.
   */
  signal?: AbortSignal | undefined;
}

interface PreparedFile {
  name: string;
  content: string;
}

/** Sanitized, de-duplicated, in the order the request sent them. */
export function prepareFiles(files: RunnerRequest["files"]): PreparedFile[] {
  const seen = new Set<string>();
  return files.map((file, index) => {
    let name = sanitizeFileName(file.name, index);
    while (seen.has(name)) name = `${index}_${name}`;
    seen.add(name);
    return { name, content: file.content };
  });
}

/**
 * The limits actually applied: what the request asked for, capped by what this
 * deployment allows.
 *
 * The wire schema bounds them too, but it is the CALLER's contract — it says
 * what a question type may write, not what this machine can afford. The three
 * ceilings default to the schema's own maxima, so clamping is invisible until
 * an operator lowers one (`config.ts`).
 */
export function effectiveLimits(
  request: RunnerRequest,
  config: RunnerConfig,
): { timeMs: number; memoryMb: number; outputBytes: number } {
  return {
    timeMs: Math.min(request.limits.timeMs, config.RUNNER_MAX_TIME_MS),
    memoryMb: Math.min(request.limits.memoryMb, config.RUNNER_MAX_MEMORY_MB),
    outputBytes: Math.min(request.limits.outputKb, config.RUNNER_MAX_OUTPUT_KB) * 1024,
  };
}

/**
 * The budget of a request on this deployment, in ms: the formula of
 * `@quiz/core` (ADR-101) over this runner's own ceilings, and the request's
 * `budgetMs` when the API sent one.
 */
export function budgetMs(request: RunnerRequest, config: RunnerConfig): number {
  return requestBudgetMs(request, {
    maxTimeMs: config.RUNNER_MAX_TIME_MS,
    compileTimeoutMs: config.RUNNER_COMPILE_TIMEOUT_MS,
    caseGraceMs: config.RUNNER_CASE_GRACE_MS,
    requestTimeoutMs: config.RUNNER_REQUEST_TIMEOUT_MS,
  });
}

/** How long the container is allowed to exist, in seconds: the budget and its slack. */
export function containerTtlSeconds(request: RunnerRequest, config: RunnerConfig): number {
  return ttlSeconds(budgetMs(request, config));
}

/** A container's life for a run of this budget, in seconds: the budget and its slack. */
export function ttlSeconds(budget: number): number {
  return Math.ceil((budget + RUNNER_TTL_SLACK_MS) / 1000);
}

/**
 * The verdict of one case, from what the engine gave back.
 *
 * `timeout -s KILL` and a cgroup OOM kill both end up as exit 137, so the
 * elapsed time is what tells them apart: a program killed at its deadline has
 * burnt its whole budget, a program killed by the memory limit has not.
 */
export function classify(
  result: ExecResult,
  timeMs: number,
): { timedOut: boolean; oom: boolean; exitCode: number | null } {
  const killed = result.exitCode === 137 || result.exitCode === 124 || result.exitCode === 143;
  const atDeadline = result.ms >= timeMs * 0.9;
  const timedOut = result.timedOut || (killed && atDeadline);
  return {
    timedOut,
    oom: !timedOut && (result.exitCode === 137 || result.containerGone),
    // A case the service killed has no exit code of its own to report.
    exitCode: result.timedOut ? null : result.exitCode,
  };
}

export async function executeRequest(
  request: RunnerRequest,
  deps: ExecuteDeps,
): Promise<RunnerOutcome> {
  const { engine, config } = deps;
  // The request's budget runs from here, its build included (ADR-101).
  const deadline = Date.now() + budgetMs(request, config);
  const files = prepareFiles(request.files);
  const plan = planFor(
    request.language,
    files.map((file) => file.name),
    splitCompileArgs(request.compileArgs),
  );
  if (plan === null) {
    throw new ExecuteError(
      `no ${request.language} source file in the request`,
      "no_source_file",
    );
  }

  const limits = effectiveLimits(request, config);
  const outputBytes = limits.outputBytes;
  const create = {
    image: imageRef(config, request.language),
    memoryMb: limits.memoryMb,
    pidsLimit: 64,
    cpus: 1,
    workdirMb: config.RUNNER_WORKDIR_MB,
    ttlSeconds: containerTtlSeconds(request, config),
  };

  return withContainer(deps, create, async ({ name, stopIfAborted, recreate }) => {
    /** Puts a fresh container in the state a case expects: the sources, the build. */
    const start = async (): Promise<{ ok: boolean; stdout: string; stderr: string; ms: number }> => {
      for (const file of files) {
        // `cp /dev/stdin <name>` and not a shell redirection: the file name is
        // an argument, so it cannot become part of a command line.
        const written = await engine.exec(name, {
          argv: ["cp", "/dev/stdin", file.name],
          stdin: file.content,
          timeoutMs: 30_000,
          maxBytes: 16 * 1024,
        });
        if (written.exitCode !== 0) {
          throw new ExecuteError(`could not write ${file.name}`, "upload_failed");
        }
      }
      return compile(engine, name, plan, config, outputBytes);
    };

    const compiled = await start();
    // A build failure is a complete answer: there is nothing to run, and
    // `finalizeRunnerCode` reads the empty case list as "every case failed".
    if (!compiled.ok || request.action === "check") {
      return { compile: compiled, cases: [] };
    }

    const cases: RunnerOutcome["cases"] = [];
    // The whole request has a budget too: a hundred cases of two seconds must
    // not hold a slot of the queue for three minutes, and a Run click's
    // fifteen infinite loops answer within the API's wait (ADR-101). A case
    // starts only if it can end before the deadline; the rest are reported
    // timed out, which is the program's verdict, not a failed call.
    const caseCost = limits.timeMs + config.RUNNER_CASE_GRACE_MS;

    for (const testCase of request.cases) {
      stopIfAborted();
      if (Date.now() + caseCost > deadline) {
        cases.push(dead(limits.timeMs));
        continue;
      }
      // The program and its own `argv[1..]`, under both clocks.
      const { lost, ...result } = await runArgv(engine, name, {
        argv: [...plan.run, ...testCase.args],
        stdin: testCase.stdin,
        timeMs: limits.timeMs,
        maxBytes: outputBytes,
        graceMs: config.RUNNER_CASE_GRACE_MS,
      });
      cases.push(result);

      // Either the service's clock fired — and then the in-container reaper
      // failed, so the container is not to be trusted — or the container died
      // under the OOM killer. Both mean: destroy it, build a fresh one, and
      // keep the remaining cases honest. No rebuild once no case could run
      // after it: the rest are past the budget anyway.
      if (lost) {
        const restarted =
          Date.now() + caseCost > deadline
            ? null
            : await recreate()
                .then(start)
                .catch(() => null);
        if (restarted === null || !restarted.ok) {
          while (cases.length < request.cases.length) cases.push(dead(limits.timeMs));
          break;
        }
      }
    }

    return { compile: compiled, cases };
  });
}

/** What `withContainer` hands its body. */
export interface Container {
  name: string;
  /** Throws `aborted` once the caller has gone. */
  stopIfAborted: () => void;
  /** Destroys the container and creates it again, empty. */
  recreate: () => Promise<void>;
}

/**
 * One container for the length of `body`: created hardened (`containerArgs`),
 * destroyed in a `finally` whatever happened, and at once when the caller goes
 * away (`deps.signal`) — the same `remove` that ends a case past its
 * deadline. Shared by a code question's run and a project run.
 */
export async function withContainer<T>(
  deps: ExecuteDeps,
  create: Omit<CreateOptions, "name">,
  body: (container: Container) => Promise<T>,
): Promise<T> {
  const { engine, signal } = deps;
  const name = (deps.containerName ?? (() => `quiz-run-${randomUUID()}`))();
  const stopIfAborted = (): void => {
    if (signal?.aborted) throw new ExecuteError("the caller has gone", "aborted");
  };
  const make = async (): Promise<void> => {
    stopIfAborted();
    await engine.create({ ...create, name });
    // An abort during `create` found no container to remove yet.
    stopIfAborted();
  };
  const onAbort = (): void => void engine.remove(name).catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await make();
    return await body({
      name,
      stopIfAborted,
      recreate: async () => {
        await engine.remove(name);
        await make();
      },
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await engine.remove(name).catch(() => undefined);
  }
}

/** One program run under both clocks, as {@link runArgv} reports it. */
export interface ArgvRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  oom: boolean;
  truncated: boolean;
  /**
   * The service's clock fired (the in-container reaper failed) or the
   * container died: it is not to be trusted any more.
   */
  lost: boolean;
}

/**
 * Runs `argv` in the container under `timeout -s KILL <s>` (`caseArgv`) and
 * the service's own clock, `timeMs` plus the grace, and classifies the end
 * (`classify`). A code question's case and a project's step both run here.
 */
export async function runArgv(
  engine: Engine,
  name: string,
  run: { argv: readonly string[]; stdin: string; timeMs: number; maxBytes: number; graceMs: number },
): Promise<ArgvRun> {
  const seconds = Math.max(1, Math.ceil(run.timeMs / 1000));
  const result = await engine.exec(name, {
    argv: caseArgv(run.argv, seconds, []),
    stdin: run.stdin,
    timeoutMs: run.timeMs + run.graceMs,
    maxBytes: run.maxBytes,
  });
  const verdict = classify(result, run.timeMs);
  return {
    exitCode: verdict.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ms: result.ms,
    timedOut: verdict.timedOut,
    oom: verdict.oom,
    truncated: result.truncated,
    lost: result.timedOut || result.containerGone,
  };
}

/** A case that never ran: the container could not be brought back. */
function dead(timeMs: number): RunnerOutcome["cases"][number] {
  return {
    exitCode: null,
    stdout: "",
    stderr: "",
    ms: timeMs,
    timedOut: true,
    oom: false,
    truncated: false,
  };
}

async function compile(
  engine: Engine,
  name: string,
  plan: LanguagePlan,
  config: RunnerConfig,
  outputBytes: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; ms: number }> {
  if (plan.compile === null) return { ok: true, stdout: "", stderr: "", ms: 0 };
  const result = await engine.exec(name, {
    argv: plan.compile,
    stdin: "",
    timeoutMs: config.RUNNER_COMPILE_TIMEOUT_MS,
    maxBytes: outputBytes,
  });
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    stdout: result.stdout,
    stderr: result.timedOut ? "compilation exceeded its time budget" : result.stderr,
    ms: result.ms,
  };
}
