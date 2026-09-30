import Fastify, { type FastifyInstance } from "fastify";
import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";

import { registerHttpMetrics, serverErrorsOf } from "./httpMetrics.js";

const ID = "3f2b8c1e-5d4a-4e6b-9c7d-0a1b2c3d4e5f";

async function server() {
  const app = Fastify({ logger: false });
  const registry = new Registry();
  registerHttpMetrics(app, registry);
  app.get("/things/:id", async () => ({ ok: true }));
  app.get("/broken/:id", async (_req, reply) => reply.code(500).send({ error: "internal_error" }));
  app.get("/unavailable", async (_req, reply) => reply.code(503).send({}));
  await app.ready();
  return { app, registry };
}

describe("the HTTP metrics", () => {
  it("label a request by its route template and status class, never by its URL", async () => {
    const { app, registry } = await server();
    await app.inject({ method: "GET", url: `/things/${ID}?token=abc` });
    await app.inject({ method: "GET", url: `/nowhere/${ID}` });
    const text = await registry.metrics();
    expect(text).toContain('quiz_http_requests_total{method="GET",route="/things/:id",status="2xx"} 1');
    expect(text).toContain('quiz_http_requests_total{method="GET",route="unmatched",status="4xx"} 1');
    expect(text).toContain('quiz_http_request_duration_seconds_bucket{le="0.025",method="GET",route="/things/:id"}');
    expect(text).not.toContain(ID);
    expect(text).not.toContain("abc");
    await app.close();
  });

  it("keep the day's server errors with the routes that answered most of them", async () => {
    const { app } = await server();
    expect(serverErrorsOf(app)).toEqual({ count: 0, top: [] });
    for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url: `/broken/${ID}-${i}` });
    await app.inject({ method: "GET", url: "/unavailable" });
    await app.inject({ method: "GET", url: `/things/${ID}` });
    expect(serverErrorsOf(app)).toEqual({
      count: 4,
      top: [
        { route: "/broken/:id", count: 3 },
        { route: "/unavailable", count: 1 },
      ],
    });
    // A day later, they have fallen out of the window.
    expect(serverErrorsOf(app, Date.now() + 25 * 3_600_000)).toEqual({ count: 0, top: [] });
    await app.close();
  });

  it("keep no window for an instance they were not registered on", () => {
    expect(serverErrorsOf(Fastify())).toBeNull();
  });

  it("are read from a plugin's own instance, as the admin routes read them", async () => {
    const app = Fastify({ logger: false });
    registerHttpMetrics(app, new Registry());
    app.get("/broken", async (_req, reply) => reply.code(500).send({}));
    let child: FastifyInstance | undefined;
    await app.register(async (c) => {
      child = c;
    });
    await app.ready();
    await app.inject({ method: "GET", url: "/broken" });
    expect(child).not.toBe(app);
    expect(serverErrorsOf(child!)).toMatchObject({ count: 1 });
    await app.close();
  });
});
