import {
  PROJECT_ARCHIVE_MAX_BASE64,
  ProjectRunResult,
  RunnerHealth,
  RunnerOutcome,
  type RunnerRequest,
} from "@quiz/core/server";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createFakeEngine, type FakeEngine } from "./test/fakeEngine.js";
import { testConfig } from "./test/config.js";
import { rawTar } from "./test/tarFixture.js";

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

  it("names the OCI runtime in the contract, and leaves it out when the engine did not say", async () => {
    const health = RunnerHealth.parse((await (await start(createFakeEngine())).inject({ url: "/health" })).json());
    expect(health.runtime).toBe("crun");
    await app?.close();

    const silent = createFakeEngine();
    const unnamed = { ...silent, capabilities: { ...silent.capabilities, runtime: null } };
    const body = (await (await start(unnamed)).inject({ url: "/health" })).json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("runtime");
    expect(RunnerHealth.safeParse(body).success).toBe(true);
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

  it("refuses a request with no source file for its language, as a 400", async () => {
    const engine = createFakeEngine();
    const server = await start(engine);
    const res = await server.inject({
      method: "POST",
      url: "/run",
      payload: { ...REQUEST, files: [{ name: "notes.txt", content: "hello" }] },
    });
    // 400 and not 503: the request will never succeed, and `HttpRunner`
    // retries a 503. Nothing was started, either.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "no_source_file" });
    expect(engine.created).toEqual([]);
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

describe("a client that goes away", () => {
  it("frees its slot: dequeued while waiting, container destroyed while running", async () => {
    // A case blocks until its container is removed — what `podman rm -f`
    // does to a running `podman exec`.
    const engine = createFakeEngine();
    const gone = new Map<string, () => void>();
    const blocking = {
      ...engine,
      exec: async (name: string, options: Parameters<typeof engine.exec>[1]) => {
        if (options.argv[0] !== "timeout") return engine.exec(name, options);
        await new Promise<void>((resolve) => gone.set(name, resolve));
        return { ...(await engine.exec(name, options)), containerGone: true };
      },
      remove: async (name: string) => {
        gone.get(name)?.();
        return engine.remove(name);
      },
    };
    const server = await start(blocking as FakeEngine, { RUNNER_CONCURRENCY: 1 });
    const base = await server.listen({ port: 0, host: "127.0.0.1" });
    const health = async () =>
      (await (await fetch(`${base}/health`)).json()) as { queued: number; running: number };
    const post = (signal: AbortSignal) =>
      fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(REQUEST),
        signal,
      }).catch(() => undefined);
    const until = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await predicate()); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    const running = new AbortController();
    const waiting = new AbortController();
    const requests = [post(running.signal), post(waiting.signal)];
    await until(async () => (await health()).queued === 1);
    expect(await health()).toMatchObject({ running: 1, queued: 1 });

    waiting.abort();
    await until(async () => (await health()).queued === 0);
    expect(await health()).toMatchObject({ running: 1, queued: 0 });

    running.abort();
    await until(async () => (await health()).running === 0);
    expect(await health()).toMatchObject({ running: 0, queued: 0 });
    // One container only was ever created — the waiting request never ran —
    // and it was removed, not left to its `sleep`.
    expect(engine.created).toHaveLength(1);
    expect(engine.removed).toContain(engine.created[0]!.name);
    await Promise.all(requests);
  });
});

describe("POST /project", () => {
  const PROJECT = {
    archive: rawTar([{ name: "Makefile", data: "prepare:\n" }]).toString("base64"),
    image: "lab-c",
    commands: { build: ["make", "prepare"], test: ["pytest", "-q"] },
    outputs: ["report.xml"],
    limits: { timeMs: 60_000, memoryMb: 512, cpus: 1 },
    budgetMs: 120_000,
  };

  function labEngine(): FakeEngine {
    const engine = createFakeEngine();
    engine.images = [...engine.images, "localhost/quiz-runner-lab-c:latest"];
    return engine;
  }

  it("answers a ProjectRunResult", async () => {
    const server = await start(labEngine());
    const res = await server.inject({ method: "POST", url: "/project", payload: PROJECT });
    expect(res.statusCode).toBe(200);
    expect(ProjectRunResult.parse(res.json())).toMatchObject({ files: [] });
  });

  it("refuses an archive with a link in it, whole, with 400 and the entries", async () => {
    const engine = labEngine();
    const server = await start(engine);
    const archive = rawTar([
      { name: "Makefile", data: "x" },
      { name: "link", type: "2", linkname: "/etc/shadow" },
    ]).toString("base64");
    const res = await server.inject({ method: "POST", url: "/project", payload: { ...PROJECT, archive } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "archive_refused", entries: ["link: symbolic_link"] });
    expect(engine.created).toEqual([]);
  });

  it("accepts a body over the 4 MB of /run, and refuses an archive over its cap with 413", async () => {
    const server = await start(labEngine());
    const big = rawTar([{ name: "big.bin", data: Buffer.alloc(6 * 1024 * 1024) }]).toString("base64");
    const ok = await server.inject({ method: "POST", url: "/project", payload: { ...PROJECT, archive: big } });
    expect(ok.statusCode).toBe(200);

    const over = await server.inject({
      method: "POST",
      url: "/project",
      payload: { ...PROJECT, archive: "A".repeat(PROJECT_ARCHIVE_MAX_BASE64 + 4) },
    });
    expect(over.statusCode).toBe(413);
    expect(over.json()).toEqual({ error: "archive_too_large" });
  });

  it.each([
    ["a shell string instead of an argv", { commands: { test: "make && pytest" } }],
    ["an empty argv", { commands: { test: [] } }],
    ["a program starting with -", { commands: { test: ["--help"] } }],
    ["an output outside the root", { outputs: ["../etc/passwd"] }],
    ["an unknown image", { image: "ubuntu" }],
    ["a budget over 10 minutes", { budgetMs: 600_001 }],
  ])("refuses %s with 400", async (_, override) => {
    const engine = labEngine();
    const server = await start(engine);
    const res = await server.inject({ method: "POST", url: "/project", payload: { ...PROJECT, ...override } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    expect(engine.created).toEqual([]);
  });

  it("refuses an archive that is not a tar with 400, before any container", async () => {
    const engine = labEngine();
    const server = await start(engine);
    const res = await server.inject({
      method: "POST",
      url: "/project",
      payload: { ...PROJECT, archive: Buffer.from("x".repeat(700)).toString("base64") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "archive_invalid" });
    expect(engine.created).toEqual([]);
  });

  it("answers 503 image_unavailable without the lab image", async () => {
    const server = await start(createFakeEngine());
    const res = await server.inject({ method: "POST", url: "/project", payload: PROJECT });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "image_unavailable", image: "lab-c" });
  });

  it("admits at most RUNNER_PROJECT_QUEUE_MAX project runs, then 429", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = labEngine();
    const create = engine.create.bind(engine);
    engine.create = async (options) => {
      await held;
      return create(options);
    };
    const server = await start(engine, { RUNNER_PROJECT_QUEUE_MAX: 1 });
    const first = server.inject({ method: "POST", url: "/project", payload: PROJECT });
    // The first is admitted and waits in `create`.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await server.inject({ method: "POST", url: "/project", payload: PROJECT });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: "queue_full" });
    release();
    expect((await first).statusCode).toBe(200);
  });
});
