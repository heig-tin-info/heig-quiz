/**
 * The runner module: one `RunnerService` on the Fastify instance.
 *
 * `RUNNER_MODE` selects the implementation once, at boot. Everything that
 * grades code takes `app.runner` and never looks at the configuration again,
 * so the stub and the real service are interchangeable by construction.
 *
 * No route lives here: `POST /questions/:id/try` (WP4) and
 * `POST /attempts/:id/run` (WP5) belong to their own modules and call this
 * service.
 */
import type { RunnerService } from "@quiz/core/server";

import type { AppConfig } from "../../config.js";
import { HttpRunner, type FetchLike } from "./http.js";
import { UnavailableRunner } from "./unavailable.js";

export { HttpRunner, type FetchLike, type HttpRunnerOptions } from "./http.js";
export { UnavailableRunner } from "./unavailable.js";

/** What `/healthz` says about the runner. `stub` is a choice, not a failure. */
export type RunnerCheck = "up" | "down" | "disabled";

export function createRunner(config: AppConfig, fetchImpl?: FetchLike): RunnerService {
  if (config.RUNNER_MODE === "http") {
    return new HttpRunner({
      url: config.RUNNER_URL,
      timeoutMs: config.RUNNER_TIMEOUT_MS,
      ...(config.RUNNER_TOKEN === "" ? {} : { token: config.RUNNER_TOKEN }),
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
  }
  return new UnavailableRunner("not_configured");
}

/**
 * The `/healthz` line. With `RUNNER_MODE=stub` the answer is `disabled`: the
 * platform is running exactly as configured, and a container-less machine must
 * not report itself unhealthy (decision D14).
 */
export async function runnerCheck(
  config: AppConfig,
  runner: RunnerService,
): Promise<RunnerCheck> {
  if (config.RUNNER_MODE === "stub") return "disabled";
  const health = await runner.health();
  return health.ok ? "up" : "down";
}

declare module "fastify" {
  interface FastifyInstance {
    /** Always present; may be the stub that throws `RunnerUnavailable`. */
    runner: RunnerService;
  }
}
