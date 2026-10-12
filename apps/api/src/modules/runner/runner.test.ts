/**
 * The runner selection and the HTTP mapping.
 *
 * The HTTP tests run against a real Fastify server on a loopback port rather
 * than a mocked `fetch`: what is under test IS the HTTP behaviour (status
 * codes, `Retry-After`, a body that arrives late, a socket that is not there),
 * and a mock would be a restatement of the code it checks.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  RunnerBusy,
  RunnerUnavailable,
  type ProjectRunRequest,
  type ProjectRunResult,
  type RunnerOutcome,
  type RunnerRequest,
} from "@quiz/core/server";

import { loadConfig } from "../../config.js";
import { createRunner, HttpRunner, runnerCheck, UnavailableRunner } from "./index.js";

const REQUEST: RunnerRequest = {
  language: "c",
  files: [{ name: "main.c", content: "int main(void) { return 0; }" }],
  compileArgs: "",
  action: "run",
  limits: { timeMs: 1000, memoryMb: 64, outputKb: 16 },
  cases: [{ name: "one", args: [], stdin: "" }],
  priority: "grading",
};

const OUTCOME: RunnerOutcome = {
  compile: { ok: true, stdout: "", stderr: "", ms: 11 },
  cases: [
    {
      exitCode: 0,
      stdout: "6\n",
      stderr: "",
      ms: 4,
      timedOut: false,
      oom: false,
      truncated: false,
    },
  ],
};

describe("UnavailableRunner", () => {
  const runner = new UnavailableRunner();

  it("throws RunnerUnavailable instead of pretending to run", async () => {
    await expect(runner.run()).rejects.toBeInstanceOf(RunnerUnavailable);
    await expect(runner.run()).rejects.toMatchObject({ code: "runner_unavailable" });
  });

  it("reports itself down, with a reason", async () => {
    expect(await runner.health()).toEqual({
      ok: false,
      languages: [],
      queued: 0,
      avgMs: null,
      reason: "not_configured",
    });
  });
});

describe("createRunner", () => {
  it("defaults to the stub, everywhere", async () => {
    const config = loadConfig({});
    expect(config.RUNNER_MODE).toBe("stub");
    const runner = createRunner(config);
    expect(runner).toBeInstanceOf(UnavailableRunner);
    // A stub is a choice, not a failure: /healthz says so.
    expect(await runnerCheck(config, runner)).toBe("disabled");
  });

  it("builds the HTTP runner when one is configured", () => {
    const config = loadConfig({ RUNNER_MODE: "http", RUNNER_URL: "http://runner:8080/" });
    expect(config.RUNNER_URL).toBe("http://runner:8080");
    expect(createRunner(config)).toBeInstanceOf(HttpRunner);
  });

  it("requires the shared token in production, and only there", () => {
    const prod = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://quiz@db/quiz",
      OIDC_CLIENT_SECRET: "a-real-one",
      COOKIE_SECRET: "a-real-cookie-secret-of-the-right-length",
      RUNNER_MODE: "http",
      RUNNER_URL: "https://r.example",
    };
    const token = "r".repeat(32);
    expect(() => loadConfig(prod)).toThrow(/RUNNER_TOKEN/);
    // Audit L19: a brute-forceable token is refused too, trimmed first.
    expect(() => loadConfig({ ...prod, RUNNER_TOKEN: ` ${"r".repeat(31)} ` })).toThrow(/RUNNER_TOKEN must be at least 32/);
    expect(loadConfig({ ...prod, RUNNER_TOKEN: ` ${token} ` }).RUNNER_TOKEN).toBe(token);
    expect(loadConfig({ RUNNER_MODE: "http", RUNNER_URL: "http://localhost:3200" }).RUNNER_TOKEN).toBe("");
  });

  it("refuses to boot with RUNNER_MODE=http and no address", () => {
    expect(() => loadConfig({ RUNNER_MODE: "http" })).toThrow(/RUNNER_URL/);
    expect(() => loadConfig({ RUNNER_MODE: "http", RUNNER_URL: "  " })).toThrow(/RUNNER_URL/);
  });

  it("rejects an unknown mode and an out-of-range timeout", () => {
    expect(() => loadConfig({ RUNNER_MODE: "podman" })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ RUNNER_TIMEOUT_MS: "10" })).toThrow(/Invalid configuration/);
  });
});

describe("HttpRunner", () => {
  let server: FastifyInstance;
  let url: string;
  let hits: string[] = [];
  let auths: Array<string | undefined> = [];
  let bodies: unknown[] = [];

  beforeAll(async () => {
    server = Fastify();
    server.addHook("onRequest", async (req) => {
      hits.push(req.url);
      auths.push(req.headers.authorization);
    });
    server.post("/run", async (req, reply) => {
      bodies.push(req.body);
      return reply.send(OUTCOME);
    });
    server.post("/garbage/run", async (_req, reply) => reply.send({ nothing: "useful" }));
    // Past the 32 MB cap: a runner that streams without end.
    server.post("/huge/run", async (_req, reply) =>
      reply.send({ ...OUTCOME, compile: { ...OUTCOME.compile, stderr: "x".repeat(33 << 20) } }),
    );
    // The widest output a case may legitimately have: 256 KB of control
    // bytes, each escaped to six in the JSON.
    server.post("/control/run", async (_req, reply) =>
      reply.send({ ...OUTCOME, cases: [{ ...OUTCOME.cases[0]!, stdout: "\x01".repeat(256 << 10) }] }),
    );
    server.post("/busy/run", async (_req, reply) =>
      reply.code(429).header("retry-after", "2").send({ error: "busy" }),
    );
    server.post("/down/run", async (_req, reply) => reply.code(503).send({ error: "no_engine" }));
    server.post("/bad/run", async (_req, reply) =>
      reply.code(400).send({ error: "no_source_file" }),
    );
    server.post("/teapot/run", async (_req, reply) => reply.code(418).send({ error: "teapot" }));
    server.post("/slow/run", async (_req, reply) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return reply.send(OUTCOME);
    });
    server.get("/health", async (_req, reply) =>
      reply.send({ ok: true, languages: ["c", "python"], queued: 2, avgMs: 412 }),
    );
    server.get("/gvisor/health", async (_req, reply) =>
      reply.send({ ok: true, languages: ["c"], queued: 0, avgMs: null, runtime: "runsc", warning: "x" }),
    );
    server.get("/sick/health", async (_req, reply) => reply.code(500).send({ error: "nope" }));
    server.get("/garbage/health", async (_req, reply) => reply.send({ almost: true }));
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  const runnerAt = (path = "", waitMs?: number, retries = 1) =>
    new HttpRunner({
      url: `${url}${path}`,
      interactiveCeilingMs: 30_000,
      retries,
      ...(waitMs === undefined ? {} : { waitMs: () => waitMs }),
    });

  it("returns the parsed outcome on 200", async () => {
    expect(await runnerAt().run(REQUEST)).toEqual(OUTCOME);
  });

  /** Fifteen cases of 2 s: 20 s build + 15 × (2 s + 2 s grace) + 3 × 2 s uploads = 86 s. */
  const fifteen = {
    ...REQUEST,
    limits: { ...REQUEST.limits, timeMs: 2000 },
    cases: Array.from({ length: 15 }, (_, i) => ({ name: `c${i}`, args: [], stdin: "" })),
  };

  it("caps an interactive request's budget at the ceiling, which the runner enforces (ADR-101)", async () => {
    bodies = [];
    const interactive = { ...fifteen, priority: "interactive" as const };
    await runnerAt().run(interactive);
    expect(bodies).toEqual([{ ...interactive, budgetMs: 30_000 }]);
  });

  it("gives a grading request its full budget, and waits for it past the queue allowance (ADR-101)", async () => {
    bodies = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await runnerAt().run(fifteen);
      // Never the interactive ceiling: a grading run is cut by its own budget only.
      expect(bodies).toEqual([{ ...fifteen, budgetMs: 86_000 }]);
      // The API waits the budget plus the grading queue's 60 s allowance.
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout.mock.calls[0]![0]).toBeGreaterThanOrEqual(86_000 + 60_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("sends the shared token as a bearer on both routes, and nothing without one", async () => {
    auths = [];
    const withToken = new HttpRunner({ url, interactiveCeilingMs: 30_000, token: "s3cret" });
    await withToken.run(REQUEST);
    await withToken.health();
    expect(auths).toEqual(["Bearer s3cret", "Bearer s3cret"]);

    auths = [];
    await runnerAt().run(REQUEST);
    expect(auths).toEqual([undefined]);
  });

  it("ignores a trailing slash in the configured URL", async () => {
    expect(await new HttpRunner({ url: `${url}///`, interactiveCeilingMs: 30_000 }).run(REQUEST)).toEqual(
      OUTCOME,
    );
  });

  it("treats a 200 that is not an outcome as no runner at all", async () => {
    await expect(runnerAt("/garbage").run(REQUEST)).rejects.toMatchObject({
      code: "runner_unavailable",
      reason: "bad_response",
    });
  });

  it("reads a full output of control bytes, however the JSON escapes it", async () => {
    const outcome = await runnerAt("/control").run(REQUEST);
    expect(outcome.cases[0]!.stdout).toBe("\x01".repeat(256 << 10));
  });

  it("stops reading a body past its cap", async () => {
    await expect(runnerAt("/huge").run(REQUEST)).rejects.toMatchObject({
      code: "runner_unavailable",
      reason: "response_too_large",
    });
  });

  it("maps 429 to RunnerBusy and keeps Retry-After", async () => {
    hits = [];
    const error = await runnerAt("/busy").run(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerBusy);
    expect((error as RunnerBusy).retryAfterMs).toBe(2000);
    // A full queue is never retried: that is how it stays full.
    expect(hits).toHaveLength(1);
  });

  it("retries a 503 once, then gives up as unavailable", async () => {
    hits = [];
    await expect(runnerAt("/down").run(REQUEST)).rejects.toMatchObject({
      code: "runner_unavailable",
      reason: "upstream_503",
    });
    expect(hits).toHaveLength(2);
  });

  it("does not retry when the caller asked for no retry", async () => {
    hits = [];
    await expect(runnerAt("/down", undefined, 0).run(REQUEST)).rejects.toBeInstanceOf(
      RunnerUnavailable,
    );
    expect(hits).toHaveLength(1);
  });

  it("never retries a 400: the request is the one that is wrong", async () => {
    // The runner answers 400 for a request with no source file for its
    // language (`apps/runner/src/routes.ts`). Sending it again would produce
    // the same answer, three times as slowly, which is what a 503 costs.
    hits = [];
    await expect(runnerAt("/bad").run(REQUEST)).rejects.toMatchObject({
      code: "runner_unavailable",
      reason: "http_400",
    });
    expect(hits).toHaveLength(1);
  });

  it("maps any other status to unavailable, with the status in the reason", async () => {
    await expect(runnerAt("/teapot").run(REQUEST)).rejects.toMatchObject({
      reason: "http_418",
    });
  });

  it("maps a timeout to busy: the runner bounds the run, so the time went to the queue (ADR-101)", async () => {
    await expect(runnerAt("/slow", 50).run(REQUEST)).rejects.toBeInstanceOf(RunnerBusy);
  });

  it("maps a closed port to unavailable", async () => {
    const dead = new HttpRunner({ url: "http://127.0.0.1:1", interactiveCeilingMs: 30_000 });
    await expect(dead.run(REQUEST)).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("reports health without ever throwing", async () => {
    expect(await runnerAt().health()).toEqual({
      ok: true,
      languages: ["c", "python"],
      queued: 2,
      avgMs: 412,
    });
    // `runtime` is optional on both sides (ADR-016, 2026-10-11): an older
    // runner leaves it out (above), a newer one names it; what is beyond the
    // contract is dropped.
    expect(await runnerAt("/gvisor").health()).toEqual({
      ok: true,
      languages: ["c"],
      queued: 0,
      avgMs: null,
      runtime: "runsc",
    });
    expect(await runnerAt("/sick").health()).toMatchObject({ ok: false, reason: "http_500" });
    expect(await runnerAt("/garbage").health()).toMatchObject({
      ok: false,
      reason: "bad_response",
    });
    expect(
      await new HttpRunner({ url: "http://127.0.0.1:1", interactiveCeilingMs: 30_000 }).health(),
    ).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("reports up or down to /healthz once a runner is configured", async () => {
    const config = loadConfig({ RUNNER_MODE: "http", RUNNER_URL: url });
    expect(await runnerCheck(config, runnerAt())).toBe("up");
    expect(await runnerCheck(config, runnerAt("/sick"))).toBe("down");
  });
});

describe("HttpRunner.project (ADR-106 §3)", () => {
  const PROJECT: ProjectRunRequest = {
    archive: Buffer.from("tar").toString("base64"),
    image: "lab-c",
    commands: { build: ["make", "prepare"], test: ["pytest", "-q"] },
    outputs: ["report.xml"],
  };
  const RESULT: ProjectRunResult = {
    build: { exitCode: 0, stdout: "", stderr: "", ms: 10, timedOut: false, truncated: false },
    test: { exitCode: 1, stdout: "1 failed", stderr: "", ms: 20, timedOut: false, truncated: false },
    files: [
      { path: "report.xml", content: "<testsuite/>", truncated: false, size: 12 },
      { path: "build/prog", binary: true, size: 4096 },
    ],
  };

  let server: FastifyInstance;
  let url: string;
  const hits = new Map<string, number>();
  const answer = (status: number, body: unknown) => async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(status).send(body);

  beforeAll(async () => {
    server = Fastify({ bodyLimit: 64 << 20 });
    server.addHook("onRequest", async (req) => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
    });
    server.post("/project", answer(200, RESULT));
    server.post("/noimage/project", answer(503, { error: "image_unavailable", image: "lab-c" }));
    server.post("/engine/project", answer(503, { error: "engine_error" }));
    server.post("/big/project", answer(413, { error: "archive_too_large_for_workdir" }));
    server.post("/nottar/project", answer(400, { error: "archive_invalid" }));
    server.post("/link/project", answer(400, { error: "archive_refused", entries: ["l: symbolic_link"] }));
    server.post("/schema/project", answer(400, { error: "invalid_request", issues: [] }));
    server.post("/busy/project", async (_req, reply) =>
      reply.code(429).header("retry-after", "30").send({ error: "queue_full" }),
    );
    server.post("/garbage/project", answer(200, { build: "?" }));
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    url = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  const at = (path = "") => new HttpRunner({ url: `${url}${path}`, interactiveCeilingMs: 30_000 });

  it("returns the parsed result on 200", async () => {
    expect(await at().project(PROJECT)).toEqual(RESULT);
  });

  it("answers image_unavailable as a refusal, never retried", async () => {
    expect(await at("/noimage").project(PROJECT)).toEqual({ refused: "image_unavailable" });
    expect(hits.get("/noimage/project")).toBe(1);
  });

  it("retries another 503 once, then throws RunnerUnavailable", async () => {
    await expect(at("/engine").project(PROJECT)).rejects.toBeInstanceOf(RunnerUnavailable);
    expect(hits.get("/engine/project")).toBe(2);
  });

  it("maps the archive's refusals and a schema refusal", async () => {
    expect(await at("/big").project(PROJECT)).toEqual({ refused: "archive_too_large_for_workdir" });
    expect(await at("/nottar").project(PROJECT)).toEqual({ refused: "archive_invalid" });
    expect(await at("/link").project(PROJECT)).toEqual({
      refused: "archive_refused",
      entries: ["l: symbolic_link"],
    });
    expect(await at("/schema").project(PROJECT)).toEqual({ refused: "invalid_request" });
  });

  it("throws RunnerBusy on 429, and RunnerUnavailable on a body that is not a result", async () => {
    await expect(at("/busy").project(PROJECT)).rejects.toMatchObject({ retryAfterMs: 30_000 });
    await expect(at("/busy").project(PROJECT)).rejects.toBeInstanceOf(RunnerBusy);
    await expect(at("/garbage").project(PROJECT)).rejects.toMatchObject({ reason: "bad_response" });
  });

  it("validates the request with the contract's schema before sending it", async () => {
    await expect(
      at().project({ ...PROJECT, commands: { test: ["make && pytest", ""] } }),
    ).rejects.toThrow();
    expect(hits.get("/project")).toBe(1);
  });

  it("is refused by the stub like a run", async () => {
    await expect(new UnavailableRunner().project()).rejects.toBeInstanceOf(RunnerUnavailable);
  });
});
