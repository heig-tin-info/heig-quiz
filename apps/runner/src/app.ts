import Fastify, { type FastifyInstance } from "fastify";

import type { RunnerConfig } from "./config.js";
import { createEngine, type Engine } from "./engine.js";
import { executeRequest } from "./execute.js";
import { probeEngine } from "./probe.js";
import { RunQueue } from "./queue.js";
import { registerRoutes } from "./routes.js";

export interface AppDeps {
  config: RunnerConfig;
  /** Injected by the tests; production probes Podman and builds the real one. */
  engine?: Engine;
}

export async function buildApp({ config, engine }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // The body is a whole source file set: 200 KB per file, up to eight.
    bodyLimit: 4 * 1024 * 1024,
  });

  let resolved = engine;
  if (resolved === undefined) {
    const probe = await probeEngine(config);
    resolved = createEngine({
      podmanBin: config.PODMAN_BIN,
      socket: config.PODMAN_SOCKET,
      seccompProfile: config.RUNNER_SECCOMP,
      usernsAuto: probe.capabilities.usernsAuto,
      runtime: probe.capabilities.runtime,
      capabilities: probe.capabilities,
    });
    // The hardening a deployment actually got, in one line of its journal. A
    // flag that had to be dropped is visible here, not buried in a comment.
    app.log.info(
      {
        podman: probe.capabilities.version,
        socket: config.PODMAN_SOCKET ?? "local CLI",
        rootless: probe.capabilities.rootless,
        usernsAuto: probe.capabilities.usernsAuto,
        runtime: probe.capabilities.runtime ?? "default",
        cgroups: probe.capabilities.cgroupVersion,
        seccomp: config.RUNNER_SECCOMP,
        notes: probe.notes,
      },
      "podman engine ready",
    );
  }
  const theEngine = resolved;

  const queue = new RunQueue({
    concurrency: config.RUNNER_CONCURRENCY,
    queueMax: config.RUNNER_QUEUE_MAX,
    run: (request) => executeRequest(request, { engine: theEngine, config }),
  });

  registerRoutes(app, { config, engine: theEngine, queue });
  return app;
}
