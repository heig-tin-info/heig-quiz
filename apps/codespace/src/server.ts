/**
 * Composition root of the portal (V1 of docs/milestone-0.md).
 *
 * Two listening surfaces, and that is deliberate (analyse.md § 4.1):
 *
 *  - the **portal** on `HOST:PORT` (127.0.0.1 in development): the platform
 *    boundary (`/launch`, `/api/assignments/*`), proxy to code-server, SEB
 *    routes. No login of its own: a user exists only through a launch token
 *    (ADR-047, amendment of M6-03);
 *  - the **Git channel** on `CODESPACE_GATEWAY:9418`, the address of the `cs0`
 *    bridge and nothing else, because that is the only surface a container must
 *    be able to reach. The nftables `input` rule is the second half of it.
 *
 * No dependency injection, no decorator: the modules receive what they need as
 * parameters, here.
 */
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig, type AppConfig } from "./auth/config.js";
import { classroomRoutes } from "./classroom/routes.js";
import { openDb, type Db, type DbHandle } from "./db/client.js";
import { createEngine, type Engine } from "./engine/index.js";
import {
  createForgejoForge,
  createUnconfiguredGithubForge,
  createPushEventStore,
  createRelayWorker,
  stagingTargets,
  startGitServer,
  type Forge,
  type PushEventStore,
  type RelayWorker,
} from "./git/index.js";
import { proxyPlugin } from "./proxy/index.js";
import { createSebVerifier, sebRoutes, sebStartPath, type AssignmentLookup } from "./seb/index.js";
import { createSessionManager, type SessionManager } from "./sessions/manager.js";
import { findAssignment } from "./sessions/store.js";
import { webRoutes } from "./web/routes.js";

export { loadConfig, type AppConfig } from "./auth/config.js";
export { SESSION_COOKIE, cookieValue } from "./proxy/index.js";
export { sessionCookieOptions } from "./web/routes.js";

/** The route of `seb/routes.ts` this portal no longer serves (see below). */
const STANDALONE_EXAM_START = "/exam/:assignmentId/start";

export interface Portal {
  app: FastifyInstance;
  gitApp: FastifyInstance | null;
  db: Db;
  engine: Engine;
  manager: SessionManager;
  store: PushEventStore;
  relay: RelayWorker | null;
  config: AppConfig;
  close(): Promise<void>;
}

/**
 * Destination forge of the relay **and** source of the authorization that seeds
 * the staging repository. `none` (the default) = everything stays in the
 * staging repository, with its `PushEvent`.
 *
 * GitHub is the **unconfigured** forge only: `loadConfig` refuses any GitHub
 * App credential (root invariant 15: never heig-classroom's App), so the forge
 * serves what needs no token — the clone URL of a public repository — and the
 * relay and the seeding of a private repository refuse explicitly and by name.
 * `createGithubForge` stays in `git/forge.ts`, tested, for the day an ADR
 * puts Quiz's own App on the engine VM (M6-04/M6-05).
 */
export function createForge(config: AppConfig): Forge | null {
  if (config.FORGE_KIND === "none") return null;
  if (config.FORGE_KIND === "github") return createUnconfiguredGithubForge();
  if (!config.FORGE_TOKEN) return null;
  return createForgejoForge({ baseUrl: config.FORGE_URL, token: config.FORGE_TOKEN });
}

export interface BuildOptions {
  config?: AppConfig;
  /** Database already open (tests); otherwise `DATABASE_PATH`. */
  dbHandle?: DbHandle;
  /** Engine already built (tests); otherwise a real Podman client. */
  engine?: Engine;
  /** Bind the Git server to the gateway. True by default. */
  withGitServer?: boolean;
  /** Reconcile and start the timers. True by default. */
  withTimers?: boolean;
}

export async function buildPortal(options: BuildOptions = {}): Promise<Portal> {
  const config = options.config ?? loadConfig();
  const handle = options.dbHandle ?? openDb(config.databasePath);
  const db = handle.db;

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // `TRUSTED_PROXY_IPS` is the production setting: a list of front-end
    // addresses, so `request.ip` is the student's address and not Caddy's
    // (audit M1, docs/deploy.md § 6). It wins over the boolean `TRUST_PROXY`,
    // which is development only — it makes `request.ip` controllable by
    // anyone through `X-Forwarded-For`, which an end-to-end run (heig-classroom's `scripts/e2e.ts`, not imported: M6-04) needs in order
    // to simulate a second machine, and which `loadConfig` forbids in
    // production.
    trustProxy:
      config.TRUSTED_PROXY_IPS.length > 0 ? config.TRUSTED_PROXY_IPS : config.TRUST_PROXY,
  });

  const engine =
    options.engine ??
    createEngine({
      podmanUrl: config.PODMAN_URL,
      network: config.CODESPACE_NETWORK,
      gateway: config.CODESPACE_GATEWAY,
      seccompProfile: config.seccompProfile,
      apparmorProfile: config.CODESPACE_APPARMOR_PROFILE,
      image: config.CODESPACE_IMAGE,
      memory: config.CODESPACE_MEMORY,
      cpus: config.CODESPACE_CPUS,
      pidsLimit: config.CODESPACE_PIDS_LIMIT,
      log: app.log,
    });

  const forge = createForge(config);
  const manager = createSessionManager({
    db,
    engine,
    volumesRoot: config.volumesRoot,
    graceMs: config.SESSION_GRACE_MS,
    gcIntervalMs: config.SESSION_GC_INTERVAL_MS,
    shadowIntervalMs: config.SHADOW_INTERVAL_MS,
    healthTimeoutMs: config.SESSION_HEALTH_TIMEOUT_MS,
    // `portal.internal` is the name `--add-host` gives to the gateway inside
    // the container; the remote written into the workspace uses it.
    gitRemoteHost: "portal.internal",
    gitRemotePort: config.CODESPACE_GIT_PORT,
    // Return origins of the status-bar extension's "Close" button
    // (images/c-dev/extension): the platform for a session that came from a
    // launch token, the portal otherwise.
    platformUrl: config.PLATFORM_URL,
    publicUrl: config.PUBLIC_URL,
    log: app.log,
    ...(forge
      ? {
          forgeUrlOf: (repo) => forge.pushUrl(repo),
          // A student's repository is private: the seeding of the staging
          // repository carries the same authorization as the relay, through the
          // environment.
          forgeAuthorization: (repo) => forge.authorization(repo),
        }
      : {}),
  });

  const store = createPushEventStore(db);
  const relay = forge
    ? createRelayWorker({
        store,
        forge,
        targets: stagingTargets(config.volumesRoot, (row) => manager.repoOfEvent(row)),
        log: app.log,
      })
    : null;

  // No signed cookie: the session and exam cookies carry their own HMAC.
  await app.register(cookie);

  // --- exam side -----------------------------------------------------------
  const verifier = createSebVerifier({
    mode: config.SEB_VERIFIER,
    nodeEnv: config.NODE_ENV,
    url:
      config.SEB_PUBLIC_ORIGIN !== ""
        ? { publicOrigin: config.SEB_PUBLIC_ORIGIN }
        : { defaultProtocol: "http" as const },
  });
  const publicOrigin = config.SEB_PUBLIC_ORIGIN || config.PUBLIC_URL;
  const lookup: AssignmentLookup = {
    find(assignmentId) {
      const row = findAssignment(db, assignmentId);
      // Only an assignment in exam mode has a `.seb` and a start route.
      if (!row || row.mode !== "exam" || !row.sebConfig) return undefined;
      const seb = row.sebConfig;
      return {
        id: row.id,
        configKey: row.configKey ?? "",
        beks: row.beks,
        // An assignment synchronised from the platform carries its own
        // `startURL`: it is the platform that authenticates the student and then
        // redirects to `/launch`. The Config Key was computed on that URL, so
        // the `.seb` served here must reuse it as it is.
        startUrl: seb.startUrl ?? new URL(sebStartPath(row.id), publicOrigin).href,
        quitUrl: seb.quitUrl ?? new URL("/", publicOrigin).href,
        examKeySalt: seb.examKeySalt,
        ...(seb.extraAllowedHosts ? { extraAllowedHosts: seb.extraAllowedHosts } : {}),
      };
    },
  };

  // The standalone exam start (`/exam/:id/start` of `seb/routes.ts`) opened a
  // session for the portal's own logged-in user; that login is gone, so an
  // exam opens through `/launch` only, where the same verifier runs. The
  // route stays in `seb/` (M6-07 moves the SEB code onto `packages/seb`) but
  // answers 404 here, before any verification, like a route that does not
  // exist.
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url === STANDALONE_EXAM_START) return reply.callNotFound();
  });

  await app.register(sebRoutes, {
    lookup,
    verifier,
    cookieSecret: config.EXAM_COOKIE_SECRET,
    cookieSecure: config.NODE_ENV === "production",
    cookieMaxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS,
    onStart() {
      throw new Error(`unreachable: ${STANDALONE_EXAM_START} answers 404 (no portal login)`);
    },
  });

  // --- boundary with the platform ------------------------------------------
  // Without a shared secret, the plugin is not registered: `/launch` and
  // `/api/assignments/*` answer 404 and the portal opens no session.
  if (config.CODESPACE_LAUNCH_SECRET !== "") {
    await app.register(classroomRoutes, {
      config,
      db,
      manager,
      verifier,
      ...(forge ? { repoUrl: (repo) => forge.pushUrl(repo) } : {}),
    });
  } else {
    app.log.info(
      {},
      "CODESPACE_LAUNCH_SECRET missing: platform integration disabled (no session can open)",
    );
  }

  await app.register(webRoutes);
  await app.register(proxyPlugin, {
    db,
    manager,
    examCookieSecret: config.EXAM_COOKIE_SECRET,
    examCookieMaxAgeMs: config.EXAM_COOKIE_MAX_AGE_MS,
  });

  app.get("/healthz", async () => ({ ok: true }));

  // --- Git channel ---------------------------------------------------------
  let gitApp: FastifyInstance | null = null;
  if (options.withGitServer !== false) {
    const started = await startGitServer({
      sessions: manager.lookup,
      store,
      volumesRoot: config.volumesRoot,
      host: config.CODESPACE_GATEWAY,
      port: config.CODESPACE_GIT_PORT,
      ...(relay ? { relay } : {}),
    });
    gitApp = started.app;
    app.log.info(
      { host: started.host, port: started.port },
      "Git channel bound (analyse.md 4.1: the only surface reachable from a container)",
    );
  }

  if (options.withTimers !== false) {
    await manager.reconcile();
    manager.startTimers();
    relay?.start();
  }

  return {
    app,
    gitApp,
    db,
    engine,
    manager,
    store,
    relay,
    config,
    async close() {
      relay?.stop();
      await manager.stopTimers();
      if (gitApp) await gitApp.close();
      await app.close();
      if (!options.dbHandle) handle.close();
    },
  };
}

/** The bare portal, without database or engine: smoke test and start-up probe. */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portal = await buildPortal();
  const shutdown = async (): Promise<void> => {
    await portal.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await portal.app.listen({ port: portal.config.PORT, host: portal.config.HOST });
}
