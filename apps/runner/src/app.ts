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

  // Whatever a previous life of this service left behind. A container is
  // removed in the `finally` of its own request; a process killed between
  // `create` and that `finally` leaves an `Exited` one holding its name and
  // its share of the disk. Reaping is a startup job and never a reason not to
  // start: a failure is one log line, and the service serves.
  try {
    const pruned = await theEngine.pruneOrphans();
    if (pruned > 0) app.log.warn({ pruned }, "removed orphan containers from a previous run");
  } catch (error) {
    app.log.warn({ err: error }, "could not prune orphan containers");
  }

  const queue = new RunQueue({
    concurrency: config.RUNNER_CONCURRENCY,
    queueMax: config.RUNNER_QUEUE_MAX,
    run: (request) => executeRequest(request, { engine: theEngine, config }),
  });

  registerRoutes(app, { config, engine: theEngine, queue });
  return app;
}
