import { randomUUID } from "node:crypto";

import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";

import type { RunnerConfig } from "./config.js";
import type { Engine, ExecResult } from "./engine.js";
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

/** How long the container is allowed to exist, in seconds. */
export function containerTtlSeconds(request: RunnerRequest, config: RunnerConfig): number {
  const cases = request.action === "check" ? 0 : request.cases.length;
  const budget =
    config.RUNNER_COMPILE_TIMEOUT_MS +
    cases * (request.limits.timeMs + config.RUNNER_CASE_GRACE_MS) +
    // The uploads, plus the slack a `podman exec` round trip costs.
    (request.files.length + 2) * 2000;
  return Math.ceil(Math.min(budget, config.RUNNER_REQUEST_TIMEOUT_MS) / 1000) + 5;
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

  const outputBytes = Math.min(request.limits.outputKb, config.RUNNER_MAX_OUTPUT_KB) * 1024;
  const name = (deps.containerName ?? (() => `quiz-run-${randomUUID()}`))();
  const create = {
    name,
    image: imageRef(config, request.language),
    memoryMb: request.limits.memoryMb,
    pidsLimit: 64,
    cpus: 1,
    workdirMb: config.RUNNER_WORKDIR_MB,
    ttlSeconds: containerTtlSeconds(request, config),
  };

  /** Creates the container and puts it back in the state a case expects. */
  const start = async (): Promise<{ ok: boolean; stdout: string; stderr: string; ms: number }> => {
    await engine.create(create);
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

  try {
    const built = await start();
    const compiled = {
      ok: built.ok,
      stdout: built.stdout,
      stderr: built.stderr,
      ms: built.ms,
    };
    // A build failure is a complete answer: there is nothing to run, and
    // `finalizeRunnerCode` reads the empty case list as "every case failed".
    if (!compiled.ok || request.action === "check") {
      return { compile: compiled, cases: [] };
    }

    const cases: RunnerOutcome["cases"] = [];
    // The whole request has a budget too: a hundred cases of two seconds must
    // not hold a slot of the queue for three minutes.
    const deadline = Date.now() + config.RUNNER_REQUEST_TIMEOUT_MS;

    for (const testCase of request.cases) {
      if (Date.now() > deadline) {
        cases.push(dead(request.limits.timeMs));
        continue;
      }
      const seconds = Math.max(1, Math.ceil(request.limits.timeMs / 1000));
      const result = await engine.exec(name, {
        // The in-container reaper, then the program and its own `argv[1..]`.
        // The service's own deadline is below.
        argv: caseArgv(plan.run, seconds, testCase.args),
        stdin: testCase.stdin,
        timeoutMs: request.limits.timeMs + config.RUNNER_CASE_GRACE_MS,
        maxBytes: outputBytes,
      });
      const verdict = classify(result, request.limits.timeMs);
      cases.push({
        exitCode: verdict.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ms: result.ms,
        timedOut: verdict.timedOut,
        oom: verdict.oom,
        truncated: result.truncated,
      });

      // Either the service's clock fired — and then the in-container reaper
      // failed, so the container is not to be trusted — or the container died
      // under the OOM killer. Both mean: destroy it, build a fresh one, and
      // keep the remaining cases honest.
      if (result.timedOut || result.containerGone) {
        await engine.remove(name);
        const restarted = await start().catch(() => null);
        if (restarted === null || !restarted.ok) {
          while (cases.length < request.cases.length) cases.push(dead(request.limits.timeMs));
          break;
        }
      }
    }

    return { compile: compiled, cases };
  } finally {
    await engine.remove(name).catch(() => undefined);
  }
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
