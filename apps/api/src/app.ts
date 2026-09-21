import { existsSync } from "node:fs";
import { resolve } from "node:path";

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { sql } from "drizzle-orm";
import { collectDefaultMetrics, Gauge, Registry } from "prom-client";

import type { HealthResponse } from "@quiz/contracts";
import type { Clock } from "./clock.js";
import { authPlugin } from "./auth/plugin.js";
import { systemClock } from "./clock.js";
import type { AppConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { publish } from "./events.js";
import { adminPlugin } from "./modules/admin.js";
import { adminGuard } from "./modules/guards.js";
import { avatarPlugin } from "./modules/avatar.js";
import { coursesPlugin } from "./modules/courses.js";
import { evaluationPlugin } from "./modules/evaluation/routes.js";
import { gradingPlugin } from "./modules/grading/routes.js";
import { registerGradingJobs } from "./modules/grading/jobs.js";
import { livePlugin } from "./modules/live/routes.js";
import { notificationsPlugin } from "./modules/notifications/routes.js";
import { orgPlugin } from "./modules/org/routes.js";
import { poolPlugin } from "./modules/pool/routes.js";
import { flushCoalescers } from "./modules/realtime/bus.js";
import { realtimePlugin } from "./modules/realtime/routes.js";
import { resultsPlugin } from "./modules/results/routes.js";
import { createRunner, runnerCheck } from "./modules/runner/index.js";
import { studentPlugin } from "./modules/student.js";
import { startJobs } from "./jobs.js";
import { startTicker } from "./ticker.js";

export interface AppDeps {
  config: AppConfig;
  /**
   * The server clock (invariant 5). Production passes nothing and gets the
   * system clock; a test passes a `TestClock` and drives every deadline,
   * grace window and pause shift without waiting for the wall clock.
   */
  clock?: Clock;
}

export async function buildApp({ config, clock }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never put credentials in the logs.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    // ONE hop, named by its address (ADR-009, `TRUSTED_PROXIES`). `true`
    // would make `req.ip` the LEFT-MOST X-Forwarded-For entry, which is the
    // value the client itself sent — Caddy appends, it does not replace —
    // and the `ipAllowlist` of F-EVAL-12 would be one header away.
    trustProxy: config.TRUSTED_PROXIES,
  });

  const handle = createDb(config.DATABASE_URL, app.log);
  app.decorate("db", handle.db);
  app.decorate("clock", clock ?? systemClock);
  // One runner for the whole process, chosen once by RUNNER_MODE. Everything
  // that grades code takes `app.runner` and never reads the configuration.
  app.decorate("runner", createRunner(config));
  app.addHook("onClose", async () => {
    // Anything still inside a coalescing window is emitted before the bus
    // goes away, so a shutdown never eats the last dashboard frame.
    flushCoalescers();
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

  // Every successful HTTP mutation under a SHARED scope emits an SSE refresh
  // hint (ADR-005): a pool, a classroom or a course is read by people who did
  // not do the write, and that is the whole point of a hint.
  //
  // There is deliberately NO catch-all `else`. A hint addressed to the
  // actor's own `user:<id>` topic reaches the very tab that issued the
  // request, `useLiveUpdates` answers any hint with `invalidateQueries()`, and
  // a route that is a READ BEHIND A POST then re-issues itself for ever.
  // `POST /evaluations/:id/attempt` is exactly that shape (deviation W5-14:
  // the student asks, the server decides lobby or player), and the fallback
  // turned "Start now" into ~215 requests per second on the student's tab,
  // each invalidation cancelling the in-flight refetch so the lobby never
  // advanced. `config: { readOnly: true }` still exists for the same family
  // one scope up (`POST /questions/:id/preview`, `/try`).
  //
  // The `else` bucket was audited route by route before it went. Most of it
  // already publishes its own, better-addressed hint — the question and
  // category routes through `poolChanged`, the evaluation ones through
  // `evaluationChanged`/`stateChanged`, the grading and release ones through
  // `gradingChanged`/`resultsChanged` — and every screen invalidates its own
  // queries after its own mutation anyway. The four that had nothing left say
  // so themselves now: `PATCH /me` and the avatar (the actor's own topic, and
  // safe because they only refresh GETs), the admin teacher list (`admin`,
  // which reaches every administrator and not just the actor), and
  // `POST /pools`, whose brand-new pool has no `pool:<id>` subscriber yet.
  app.addHook("onResponse", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (reply.statusCode >= 400 || !req.user) return;
    if (req.routeOptions.config.readOnly) return;
    const pool = /^\/app\/api\/pools\/([0-9a-f-]{36})/.exec(req.url);
    const classroom = /^\/app\/api\/classrooms\/([0-9a-f-]{36})/.exec(req.url);
    const course = /^\/app\/api\/courses\/([0-9a-f-]{36})/.exec(req.url);
    if (pool) publish("mutation", [`pool:${pool[1]}`]);
    else if (classroom) publish("mutation", [`classroom:${classroom[1]}`]);
    else if (course) publish("mutation", [`course:${course[1]}`, `teacher:${req.user.id}`]);
    else if (req.url.startsWith("/app/api/courses")) publish("mutation", [`teacher:${req.user.id}`]);
  });

  await app.register(fastifyCookie, { secret: config.COOKIE_SECRET });
  await app.register(authPlugin, { config });
  await app.register(realtimePlugin);
  await app.register(adminPlugin, { config });
  await app.register(avatarPlugin);
  await app.register(coursesPlugin, { config });
  await app.register(orgPlugin);
  await app.register(poolPlugin, { config });
  await app.register(evaluationPlugin);
  await app.register(livePlugin);
  await app.register(gradingPlugin);
  await app.register(resultsPlugin);
  await app.register(notificationsPlugin);
  await app.register(studentPlugin);

  // Job queue + ticker. A database that is unreachable at boot does not kill
  // the server: healthz stays degraded until restart.
  const runWorkers = config.WORKER_MODE !== "web";
  try {
    const queue = await startJobs(app, {
      databaseUrl: config.DATABASE_URL,
      embedded: handle.embedded,
      runWorkers,
      disabled: config.JOBS_DISABLED,
    });
    // The grading queues and their handlers (PLAN-MVP §5.4). Without a queue
    // — `JOBS_DISABLED=1`, or a database that was unreachable at boot — the
    // grading pass runs inline at the call site instead of being dropped.
    if (queue) await registerGradingJobs(app, queue);
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
    // The runner never decides the overall status: `stub` is the default
    // configuration and an unreachable runner only degrades code grading to a
    // manual one (decision D14). A container must not be restarted for that.
    const runner = await runnerCheck(config, app.runner);
    const body: HealthResponse = {
      status: databaseOk ? "ok" : "degraded",
      checks: {
        database: databaseOk ? "up" : "down",
        jobs: app.boss ? "up" : "down",
        runner,
      },
      uptimeSeconds: Math.round(process.uptime()),
    };
    return reply.code(databaseOk ? 200 : 503).send(body);
  });

  /**
   * The scrape endpoint is NOT public (the default collectors publish the
   * command line, the versions and the memory profile of the process): a
   * `METRICS_TOKEN` bearer for Prometheus, an admin session otherwise.
   */
  const metricsGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = config.METRICS_TOKEN;
    if (token !== "" && req.headers.authorization === `Bearer ${token}`) return undefined;
    return adminGuard(app)(req, reply);
  };

  app.get("/metrics", { preHandler: metricsGuard }, async (_req, reply) => {
    await checkDatabase();
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: ReturnType<typeof createDb>["db"];
  }
  interface FastifyContextConfig {
    /** A read served by a non-GET verb: no refresh hint on its response. */
    readOnly?: boolean;
  }
}
