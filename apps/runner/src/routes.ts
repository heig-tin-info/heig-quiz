import { timingSafeEqual } from "node:crypto";

import {
  PROJECT_ARCHIVE_MAX_BASE64,
  ProjectRunRequest,
  RunnerRequest,
  type RunnerHealth,
  type RunnerLanguage,
} from "@quiz/core/server";
import type { FastifyInstance } from "fastify";

import type { RunnerConfig } from "./config.js";
import type { Engine } from "./engine.js";
import { ExecuteError } from "./execute.js";
import { availableLanguages, hasImage } from "./images.js";
import { prepareProject, ProjectArchiveError, runProject } from "./project.js";
import { QueueFull, type RunQueue } from "./queue.js";

/**
 * The two routes of the service, and nothing else. The wire shapes are the
 * ones `packages/core` exports — the same module the API's client parses its
 * answers with, so a drift is a compile error on both sides at once.
 *
 * `POST /run` answers, by design:
 *   200  a `RunnerOutcome`, including one where nothing compiled;
 *   400  a body that is not a `RunnerRequest`, or one with no source file for
 *        its language — both are the caller's to fix, and retrying will not;
 *   401  no `Authorization: Bearer <RUNNER_TOKEN>` while one is configured;
 *   429  the queues are full (`Retry-After`), which the API surfaces as `RunnerBusy`;
 *   503  no image for that language, or the engine refused to start a container.
 *
 * The line between 400 and 503 is whether a RETRY could ever help: `HttpRunner`
 * sends a 502/503 a second time, and nothing that is the request's own fault
 * belongs on that side.
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

  let cache: {
    at: number;
    refs: string[];
    languages: RunnerLanguage[];
    error: string | null;
  } | null = null;

  async function languages(): Promise<{
    refs: string[];
    languages: RunnerLanguage[];
    error: string | null;
  }> {
    const now = Date.now();
    if (cache !== null && now - cache.at < IMAGE_CACHE_MS) return cache;
    try {
      const refs = await engine.listImages();
      cache = { at: now, refs, languages: availableLanguages(refs, config), error: null };
    } catch {
      cache = { at: now, refs: [], languages: [], error: "engine_unreachable" };
    }
    return cache;
  }

  app.get("/health", async (): Promise<RunnerHealth & Record<string, unknown>> => {
    const found = await languages();
    const stats = queue.stats();
    const reason =
      found.error ?? (found.languages.length === 0 ? "no_language_image" : undefined);
    const runtime = engine.capabilities.runtime;
    return {
      ok: reason === undefined,
      languages: found.languages,
      queued: stats.queued,
      avgMs: stats.avgMs,
      ...(reason === undefined ? {} : { reason }),
      // In the contract, optional: an API older than this field drops it, and
      // this runner omits it when the engine did not name its runtime.
      ...(runtime === null ? {} : { runtime }),
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

    // The client going away before its answer — the API gave up, a student
    // closed the tab — frees its slot: dequeued if waiting, container
    // destroyed if running. `close` also fires after a reply was written,
    // which `writableEnded` tells apart.
    const gone = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableEnded) gone.abort();
    };
    reply.raw.on("close", onClose);
    try {
      return await queue.submit(runnerRequest, gone.signal);
    } catch (error) {
      if (gone.signal.aborted) {
        // Nobody left to answer: the socket is closed.
        request.log.info("client gone, run abandoned");
        return reply.hijack();
      }
      if (error instanceof QueueFull) {
        return reply
          .code(429)
          .header("retry-after", String(error.retryAfterSeconds))
          .send({ error: "queue_full" });
      }
      const reason = error instanceof ExecuteError ? error.reason : "engine_error";
      request.log.error({ err: error, reason }, "run failed");
      // A request whose files hold no source for its language will never
      // succeed, however many times it is sent: that is the caller's mistake,
      // and `HttpRunner` retries a 503 twice before giving up on it.
      if (reason === "no_source_file") {
        return reply.code(400).send({ error: reason });
      }
      return reply.code(503).send({ error: reason });
    } finally {
      reply.raw.off("close", onClose);
    }
  });

  /**
   * `POST /project` (ADR-106 §3): a whole repository, one container, the
   * same queue and the same flags. Answers 200 a `ProjectRunResult`; 400
   * `invalid_request`, `archive_invalid` (not a tar) or `archive_refused`
   * (an entry the sanitizer refuses, named in `entries`: the whole archive
   * is refused, invariant 12); 413
   * `archive_too_large`; 429 `queue_full` (the queues, or
   * `RUNNER_PROJECT_QUEUE_MAX` project runs already admitted); 503
   * `image_unavailable`, which no retry changes — the API reads the body
   * and does not retry it — or `engine_error`/`upload_failed`, which a retry may.
   */
  let projectsAdmitted = 0;
  app.post(
    "/project",
    // The archive's base64 and the JSON around it; `/run` keeps the app's 4 MB.
    { bodyLimit: PROJECT_ARCHIVE_MAX_BASE64 + 1024 * 1024 },
    async (request, reply) => {
      const archive = (request.body as { archive?: unknown } | null)?.archive;
      if (typeof archive === "string" && archive.length > PROJECT_ARCHIVE_MAX_BASE64) {
        return reply.code(413).send({ error: "archive_too_large" });
      }
      const parsed = ProjectRunRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }
      const found = await languages();
      if (!hasImage(found.refs, config, parsed.data.image)) {
        return reply.code(503).send({ error: "image_unavailable", image: parsed.data.image });
      }

      // Sanitized before it takes a slot: a bad archive costs no container.
      let prepared;
      try {
        prepared = prepareProject(parsed.data);
      } catch (error) {
        if (!(error instanceof ProjectArchiveError)) throw error;
        if (error.reason === "archive_too_large") return reply.code(413).send({ error: error.reason });
        return reply.code(400).send({
          error: error.reason,
          ...(error.reason === "archive_refused" ? { entries: error.entries } : {}),
        });
      }

      if (projectsAdmitted >= config.RUNNER_PROJECT_QUEUE_MAX) {
        return reply.code(429).header("retry-after", "30").send({ error: "queue_full" });
      }
      projectsAdmitted += 1;
      const gone = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableEnded) gone.abort();
      };
      reply.raw.on("close", onClose);
      try {
        return await queue.submitTask(
          "grading",
          (signal) => runProject(prepared, { engine, config, signal }),
          gone.signal,
        );
      } catch (error) {
        if (gone.signal.aborted) {
          request.log.info("client gone, project run abandoned");
          return reply.hijack();
        }
        if (error instanceof QueueFull) {
          return reply
            .code(429)
            .header("retry-after", String(error.retryAfterSeconds))
            .send({ error: "queue_full" });
        }
        const reason = error instanceof ExecuteError ? error.reason : "engine_error";
        request.log.error({ err: error, reason }, "project run failed");
        return reply.code(503).send({ error: reason });
      } finally {
        projectsAdmitted -= 1;
        reply.raw.off("close", onClose);
      }
    },
  );
}
