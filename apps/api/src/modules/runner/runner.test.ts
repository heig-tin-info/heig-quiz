/**
 * The runner selection and the HTTP mapping.
 *
 * The HTTP tests run against a real Fastify server on a loopback port rather
 * than a mocked `fetch`: what is under test IS the HTTP behaviour (status
 * codes, `Retry-After`, a body that arrives late, a socket that is not there),
 * and a mock would be a restatement of the code it checks.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RunnerBusy,
  RunnerUnavailable,
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
  cases: [{ name: "one", stdin: "" }],
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

  beforeAll(async () => {
    server = Fastify();
    server.addHook("onRequest", async (req) => {
      hits.push(req.url);
    });
    server.post("/run", async (_req, reply) => reply.send(OUTCOME));
    server.post("/garbage/run", async (_req, reply) => reply.send({ nothing: "useful" }));
    server.post("/busy/run", async (_req, reply) =>
      reply.code(429).header("retry-after", "2").send({ error: "busy" }),
    );
    server.post("/down/run", async (_req, reply) => reply.code(503).send({ error: "no_engine" }));
    server.post("/teapot/run", async (_req, reply) => reply.code(418).send({ error: "teapot" }));
    server.post("/slow/run", async (_req, reply) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return reply.send(OUTCOME);
    });
    server.get("/health", async (_req, reply) =>
      reply.send({ ok: true, languages: ["c", "python"], queued: 2, avgMs: 412 }),
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

  const runnerAt = (path = "", timeoutMs = 2000, retries = 1) =>
    new HttpRunner({ url: `${url}${path}`, timeoutMs, retries });

  it("returns the parsed outcome on 200", async () => {
    expect(await runnerAt().run(REQUEST)).toEqual(OUTCOME);
  });

  it("ignores a trailing slash in the configured URL", async () => {
    expect(await new HttpRunner({ url: `${url}///`, timeoutMs: 2000 }).run(REQUEST)).toEqual(
      OUTCOME,
    );
  });

  it("treats a 200 that is not an outcome as no runner at all", async () => {
    await expect(runnerAt("/garbage").run(REQUEST)).rejects.toMatchObject({
      code: "runner_unavailable",
      reason: "bad_response",
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
    await expect(runnerAt("/down", 2000, 0).run(REQUEST)).rejects.toBeInstanceOf(
      RunnerUnavailable,
    );
    expect(hits).toHaveLength(1);
  });

  it("maps any other status to unavailable, with the status in the reason", async () => {
    await expect(runnerAt("/teapot").run(REQUEST)).rejects.toMatchObject({
      reason: "http_418",
    });
  });

  it("maps a timeout to unavailable", async () => {
    await expect(runnerAt("/slow", 50).run(REQUEST)).rejects.toMatchObject({
      code: "runner_unavailable",
      reason: "timeout",
    });
  });

  it("maps a closed port to unavailable", async () => {
    const dead = new HttpRunner({ url: "http://127.0.0.1:1", timeoutMs: 1000 });
    await expect(dead.run(REQUEST)).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("reports health without ever throwing", async () => {
    expect(await runnerAt().health()).toEqual({
      ok: true,
      languages: ["c", "python"],
      queued: 2,
      avgMs: 412,
    });
    expect(await runnerAt("/sick").health()).toMatchObject({ ok: false, reason: "http_500" });
    expect(await runnerAt("/garbage").health()).toMatchObject({
      ok: false,
      reason: "bad_response",
    });
    expect(
      await new HttpRunner({ url: "http://127.0.0.1:1", timeoutMs: 1000 }).health(),
    ).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("reports up or down to /healthz once a runner is configured", async () => {
    const config = loadConfig({ RUNNER_MODE: "http", RUNNER_URL: url });
    expect(await runnerCheck(config, runnerAt())).toBe("up");
    expect(await runnerCheck(config, runnerAt("/sick"))).toBe("down");
  });
});
