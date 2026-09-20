import { existsSync } from "node:fs";
import { resolve } from "node:path";

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { sql } from "drizzle-orm";
import { collectDefaultMetrics, Gauge, Registry } from "prom-client";

import type { HealthResponse } from "@quiz/contracts";
import { authPlugin } from "./auth/plugin.js";
import type { AppConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { publish } from "./events.js";
import { adminPlugin } from "./modules/admin.js";
import { avatarPlugin } from "./modules/avatar.js";
import { coursesPlugin } from "./modules/courses.js";
import { eventsPlugin } from "./modules/events.js";
import { studentPlugin } from "./modules/student.js";
import { startJobs } from "./jobs.js";
import { startTicker } from "./ticker.js";

export interface AppDeps {
  config: AppConfig;
}

export async function buildApp({ config }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never put credentials in the logs.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    trustProxy: true, // always behind Caddy (ADR-009)
  });

  const handle = createDb(config.DATABASE_URL, app.log);
  app.decorate("db", handle.db);
  app.addHook("onClose", async () => {
    await handle.close();
  });

  // A 5xx must never carry the failure detail to the browser: Drizzle wraps
  // every pg failure in a `Failed query: <SQL>\nparams: <values>` message and
  // Fastify's default handler puts that message in the body. Same `{error}`
  // shape as the routes, no `message`: there is nothing actionable to say to
  // the caller. `cause` is logged next to `err` because pino's serializer
  // folds the cause chain into the message but drops the cause's own fields
  // — and for pg those (SQLSTATE `code`, `severity`) are the diagnosis.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) return reply.send(err);
    req.log.error({ err, cause: err.cause }, "request failed");
    return reply.code(status).send({ error: "internal_error" });
  });

  // Roster import: the CSV arrives as-is in req.body.
  app.addContentTypeParser(["text/csv", "text/plain"], { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );
  // Avatars: raw binary image (<= 1 MB, default Fastify limit).
  app.addContentTypeParser(
    ["image/jpeg", "image/png", "image/webp"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  // Server-rendered HTML forms (the development persona picker is the only
  // one): a plain field map, no nesting, no array syntax.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Every successful HTTP mutation emits an SSE refresh hint (ADR-005).
  app.addHook("onResponse", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (reply.statusCode >= 400 || !req.user) return;
    const classroom = /^\/app\/api\/classrooms\/([0-9a-f-]{36})/.exec(req.url);
    const course = /^\/app\/api\/courses\/([0-9a-f-]{36})/.exec(req.url);
    if (classroom) publish("mutation", [`classroom:${classroom[1]}`]);
    else if (course) publish("mutation", [`course:${course[1]}`, `teacher:${req.user.id}`]);
    else if (req.url.startsWith("/app/api/courses")) publish("mutation", [`teacher:${req.user.id}`]);
    else publish("mutation", [`user:${req.user.id}`]);
  });

  await app.register(fastifyCookie, { secret: config.COOKIE_SECRET });
  await app.register(authPlugin, { config });
  await app.register(eventsPlugin);
  await app.register(adminPlugin, { config });
  await app.register(avatarPlugin);
  await app.register(coursesPlugin, { config });
  await app.register(studentPlugin);

  // Job queue + ticker. A database that is unreachable at boot does not kill
  // the server: healthz stays degraded until restart.
  const runWorkers = config.WORKER_MODE !== "web";
  try {
    await startJobs(app, {
      databaseUrl: config.DATABASE_URL,
      embedded: handle.embedded,
      runWorkers,
    });
    if (runWorkers) startTicker(app, config);
  } catch (err) {
    app.log.error({ err }, "job queue start failed — jobs disabled");
  }

  // Built SPA served by the monolith (ADR-009: single image, frontend included).
  if (config.STATIC_DIR && existsSync(config.STATIC_DIR)) {
    await app.register(fastifyStatic, { root: resolve(config.STATIC_DIR) });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for navigation; API surfaces keep their JSON 404.
      const isApi = ["/app/", "/api/"].some((p) => req.url.startsWith(p));
      if (req.method === "GET" && !isApi) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found" });
    });
  }

  // --- Observability ---
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const dbUp = new Gauge({
    name: "quiz_database_up",
    help: "1 if the database answers SELECT 1",
    registers: [registry],
  });

  async function checkDatabase(): Promise<boolean> {
    try {
      await handle.db.execute(sql`SELECT 1`);
      dbUp.set(1);
      return true;
    } catch {
      dbUp.set(0);
      return false;
    }
  }

  app.get("/healthz", async (_req, reply) => {
    const databaseOk = await checkDatabase();
    const body: HealthResponse = {
      status: databaseOk ? "ok" : "degraded",
      checks: {
        database: databaseOk ? "up" : "down",
        jobs: app.boss ? "up" : "down",
      },
      uptimeSeconds: Math.round(process.uptime()),
    };
    return reply.code(databaseOk ? 200 : 503).send(body);
  });

  app.get("/metrics", async (_req, reply) => {
    await checkDatabase();
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: ReturnType<typeof createDb>["db"];
  }
}
