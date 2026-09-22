import { timingSafeEqual } from "node:crypto";

import { RunnerRequest, type RunnerHealth, type RunnerLanguage } from "@quiz/core/server";
import type { FastifyInstance } from "fastify";

import type { RunnerConfig } from "./config.js";
import type { Engine } from "./engine.js";
import { ExecuteError } from "./execute.js";
import { availableLanguages } from "./images.js";
import { QueueFull, type RunQueue } from "./queue.js";

/**
 * The two routes of the service, and nothing else. The wire shapes are the
 * ones `packages/core` exports — the same module the API's client parses its
 * answers with, so a drift is a compile error on both sides at once.
 *
 * `POST /run` answers, by design:
 *   200  a `RunnerOutcome`, including one where nothing compiled;
 *   400  a body that is not a `RunnerRequest`;
 *   401  no `Authorization: Bearer <RUNNER_TOKEN>` while one is configured;
 *   429  the queues are full (`Retry-After`), which the API surfaces as `RunnerBusy`;
 *   503  no image for that language, or the engine refused to start a container.
 *
 * The 401 covers `/health` too, on purpose: a token the API got wrong is then
 * a runner reported `down` by `/healthz`, not one that says `up` and refuses
 * every run.
 */

export interface RouteDeps {
  config: RunnerConfig;
  engine: Engine;
  queue: RunQueue;
}

/** The image list barely changes; asking Podman on every /health does not pay. */
const IMAGE_CACHE_MS = 5000;

/** Constant-time comparison of the presented bearer with the configured token. */
function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, engine, queue } = deps;

  if (config.RUNNER_TOKEN !== "") {
    app.addHook("onRequest", async (request, reply) => {
      if (!bearerMatches(request.headers.authorization, config.RUNNER_TOKEN)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    });
  }

  let cache: { at: number; languages: RunnerLanguage[]; error: string | null } | null = null;

  async function languages(): Promise<{ languages: RunnerLanguage[]; error: string | null }> {
    const now = Date.now();
    if (cache !== null && now - cache.at < IMAGE_CACHE_MS) return cache;
    try {
      const refs = await engine.listImages();
      cache = { at: now, languages: availableLanguages(refs, config), error: null };
    } catch {
      cache = { at: now, languages: [], error: "engine_unreachable" };
    }
    return cache;
  }

  app.get("/health", async (): Promise<RunnerHealth & Record<string, unknown>> => {
    const found = await languages();
    const stats = queue.stats();
    const reason =
      found.error ?? (found.languages.length === 0 ? "no_language_image" : undefined);
    return {
      ok: reason === undefined,
      languages: found.languages,
      queued: stats.queued,
      avgMs: stats.avgMs,
      ...(reason === undefined ? {} : { reason }),
      // Beyond the contract, for the admin health panel and for a human
      // curling the service. `RunnerHealth.safeParse` drops them silently.
      running: stats.running,
      concurrency: stats.concurrency,
      queueMax: stats.queueMax,
      engine: {
        version: engine.capabilities.version,
        rootless: engine.capabilities.rootless,
        remote: engine.capabilities.remote,
        usernsAuto: engine.capabilities.usernsAuto,
        runtime: engine.capabilities.runtime,
        cgroupVersion: engine.capabilities.cgroupVersion,
      },
    };
  });

  app.post("/run", async (request, reply) => {
    const parsed = RunnerRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const runnerRequest = parsed.data;

    const found = await languages();
    if (!found.languages.includes(runnerRequest.language)) {
      return reply
        .code(503)
        .send({ error: "language_unavailable", language: runnerRequest.language });
    }

    try {
      return await queue.submit(runnerRequest);
    } catch (error) {
      if (error instanceof QueueFull) {
        return reply
          .code(429)
          .header("retry-after", String(error.retryAfterSeconds))
          .send({ error: "queue_full" });
      }
      const reason = error instanceof ExecuteError ? error.reason : "engine_error";
      request.log.error({ err: error, reason }, "run failed");
      return reply.code(503).send({ error: reason });
    }
  });
}
