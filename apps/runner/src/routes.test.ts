import { RunnerHealth, RunnerOutcome, type RunnerRequest } from "@quiz/core/server";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createFakeEngine, type FakeEngine } from "./test/fakeEngine.js";
import { testConfig } from "./test/config.js";

/**
 * The HTTP surface, against a fake engine: the contract of `packages/core` on
 * the way in, the statuses `apps/api/src/modules/runner/http.ts` maps on the
 * way out.
 */

const REQUEST: RunnerRequest = {
  language: "c",
  files: [{ name: "main.c", content: "int main(void){return 0;}" }],
  compileArgs: "",
  action: "run",
  limits: { timeMs: 1000, memoryMb: 128, outputKb: 64 },
  cases: [{ name: "one", args: [], stdin: "" }],
  priority: "grading",
};

let app: FastifyInstance | null = null;

async function start(engine: FakeEngine, overrides = {}): Promise<FastifyInstance> {
  app = await buildApp({ config: testConfig({ LOG_LEVEL: "fatal", ...overrides }), engine });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("RUNNER_TOKEN", () => {
  it("is not asked for when none is configured", async () => {
    const server = await start(createFakeEngine());
    expect((await server.inject({ url: "/health" })).statusCode).toBe(200);
  });

  it("guards both routes with a bearer, and rejects a wrong or missing one", async () => {
    const server = await start(createFakeEngine(), { RUNNER_TOKEN: "s3cret" });
    expect((await server.inject({ url: "/health" })).statusCode).toBe(401);
    expect(
      (await server.inject({ url: "/health", headers: { authorization: "Bearer nope" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await server.inject({ url: "/health", headers: { authorization: "Basic s3cret" } }))
        .statusCode,
    ).toBe(401);
    const run = await server.inject({ method: "POST", url: "/run", payload: REQUEST });
    expect(run.statusCode).toBe(401);
    expect(run.json()).toEqual({ error: "unauthorized" });

    const ok = { authorization: "Bearer s3cret" };
    expect((await server.inject({ url: "/health", headers: ok })).statusCode).toBe(200);
    const ran = await server.inject({ method: "POST", url: "/run", payload: REQUEST, headers: ok });
    expect(ran.statusCode).toBe(200);
    RunnerOutcome.parse(ran.json());
  });
});

describe("GET /health", () => {
  it("answers a RunnerHealth listing the languages that have an image", async () => {
    const server = await start(createFakeEngine());
    const res = await server.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const health = RunnerHealth.parse(res.json());
    expect(health).toMatchObject({ ok: true, languages: ["c", "python"], queued: 0 });
    // Podman names a local image `localhost/quiz-runner-c:latest`; both forms
    // must count, or half a deployment reports no language at all.
    expect(health.languages).not.toContain("js");
  });

  it("is not ok, with a reason, when no image is there", async () => {
    const engine = createFakeEngine();
    engine.images = [];
    const server = await start(engine);
    const health = RunnerHealth.parse((await server.inject({ url: "/health" })).json());
    expect(health).toMatchObject({ ok: false, languages: [], reason: "no_language_image" });
  });

  it("reports the engine and the pool beyond the contract", async () => {
    const server = await start(createFakeEngine());
    const body = (await server.inject({ url: "/health" })).json() as Record<string, unknown>;
    expect(body).toMatchObject({ concurrency: 4, queueMax: 32, running: 0 });
    expect(body.engine).toMatchObject({ usernsAuto: true, remote: true });
  });
});

describe("POST /run", () => {
  it("answers a RunnerOutcome the API's client can parse", async () => {
    const server = await start(
      createFakeEngine((call) =>
        call.argv[0] === "timeout" ? { stdout: "42\n", exitCode: 0, ms: 7 } : {},
      ),
    );
    const res = await server.inject({ method: "POST", url: "/run", payload: REQUEST });

    expect(res.statusCode).toBe(200);
    const outcome = RunnerOutcome.parse(res.json());
    expect(outcome.compile.ok).toBe(true);
    expect(outcome.cases).toHaveLength(1);
    expect(outcome.cases[0]).toMatchObject({ stdout: "42\n", exitCode: 0 });
  });

  it("refuses a body that is not a RunnerRequest", async () => {
    const server = await start(createFakeEngine());
    const res = await server.inject({
      method: "POST",
      url: "/run",
      payload: { ...REQUEST, limits: { timeMs: 99_999_999, memoryMb: 128, outputKb: 64 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("refuses an unknown language before it starts anything", async () => {
    const server = await start(createFakeEngine());
    const res = await server.inject({
      method: "POST",
      url: "/run",
      payload: { ...REQUEST, language: "rust", files: [{ name: "main.rs", content: "" }] },
    });
    // 503, which the API reads as `RunnerUnavailable`: a language without an
    // image is a deployment that cannot serve it, not a bad request.
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "language_unavailable" });
  });

  it("answers 429 with a Retry-After once the queues are full", async () => {
    // The QUEUE's rule — the depth, the priority, the Retry-After it computes
    // — is proven in `queue.test.ts`. What is proven here is the one thing
    // HTTP adds: a `QueueFull` becomes a 429 with the header, which is what
    // `HttpRunner` turns into `RunnerBusy`.
    // One slot, one waiting request; the third is refused.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = createFakeEngine((call) => {
      if (call.argv[0] === "timeout") {
        // Blocks the only slot until the test lets go.
        return { exitCode: 0 };
      }
      return {};
    });
    const slow = {
      ...engine,
      exec: async (name: string, options: Parameters<typeof engine.exec>[1]) => {
        if (options.argv[0] === "timeout") await held;
        return engine.exec(name, options);
      },
    };
    const server = await start(slow as FakeEngine, { RUNNER_CONCURRENCY: 1, RUNNER_QUEUE_MAX: 1 });

    const first = server.inject({ method: "POST", url: "/run", payload: REQUEST });
    const second = server.inject({ method: "POST", url: "/run", payload: REQUEST });
    // Let both reach the queue: one runs, one waits, the queue is now full.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await server.inject({ method: "POST", url: "/run", payload: REQUEST });

    expect(third.statusCode).toBe(429);
    expect(Number(third.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(third.json()).toMatchObject({ error: "queue_full" });

    release();
    await Promise.all([first, second]);
  });

  it("answers 503 when the engine cannot start a container", async () => {
    const engine = createFakeEngine();
    const broken = {
      ...engine,
      create: () => Promise.reject(new Error("podman run failed")),
    };
    const server = await start(broken as FakeEngine);
    const res = await server.inject({ method: "POST", url: "/run", payload: REQUEST });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "engine_error" });
  });
});
