import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createFakeEngine, type FakeEngine } from "./test/fakeEngine.js";
import { testConfig } from "./test/config.js";

/**
 * What `buildApp` does BEFORE it serves anything.
 *
 * There is one thing, and it is the reaping: the containers another instance
 * of this service left behind are destroyed once, at boot, and never again.
 * The two properties are opposite and both matter — it really happens, and it
 * can never be the reason the service does not come up.
 */

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("buildApp", () => {
  it("reaps the orphans of a previous run, exactly once", async () => {
    const engine = createFakeEngine();
    app = await buildApp({ config: testConfig({ LOG_LEVEL: "fatal" }), engine });

    expect(engine.pruned).toHaveLength(1);
    // And nothing else was started on the way up: the queue is idle and no
    // container was created before the first request.
    expect(engine.created).toEqual([]);
  });

  it("comes up anyway when the reaping fails", async () => {
    // A Podman that answers `ps` with an error is a Podman that will probably
    // answer `/run` with one too — but that is the request's problem, reported
    // per request. A service that refuses to start reports nothing at all, and
    // `/healthz` on the API side would say `down` instead of naming the fault.
    const engine = createFakeEngine();
    const broken: FakeEngine = {
      ...engine,
      pruneOrphans: () => Promise.reject(new Error("cannot connect to podman")),
    };

    app = await buildApp({ config: testConfig({ LOG_LEVEL: "fatal" }), engine: broken });
    const res = await app.inject({ url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});
