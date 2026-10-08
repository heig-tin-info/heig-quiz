/**
 * Composition root of the portal (V1 of docs/milestone-0.md).
 *
 * Two listening surfaces, and that is deliberate (analyse.md § 4.1):
 *
 *  - the **portal** on `HOST:PORT` (127.0.0.1 in development): the platform
 *    boundary (`/launch`, `/api/assignments/*`) and the proxy to
 *    code-server. No login of its own: a user exists only through a launch
 *    token (ADR-047, amendment of M6-03), and no `.seb` of its own: the
 *    platform builds them (D21, M6-07);
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
  createQuizForge,
  createUnconfiguredGithubForge,
  createPushEventStore,
  createRelayWorker,
  stagingTargets,
  startGitServer,
  type Forge,
  type PushEventStore,
  type QuizForgeOptions,
  type RelayWorker,
} from "./git/index.js";
import { proxyPlugin } from "./proxy/index.js";
import { portalLogger, type LogStream } from "./logging.js";
import { createSebVerifier } from "./seb/index.js";
import { createSessionManager, type SessionManager } from "./sessions/manager.js";
import { webRoutes } from "./web/routes.js";

export { loadConfig, type AppConfig } from "./auth/config.js";
export { SESSION_COOKIE, cookieValue } from "./proxy/index.js";
export { sessionCookieOptions } from "./web/routes.js";

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
 * the staging repository. `none` = everything stays in the staging
 * repository, with its `PushEvent`.
 *
 * `quiz` (ADR-078, the default once the platform is configured) reaches
 * GitHub with tokens Quiz grants per repository: the portal holds no App
 * credential (`loadConfig` refuses one, root invariant 15). `github` is the
 * **unconfigured** forge — the clone URL of a public repository, no relay —
 * and `forgejo` the development one; production refuses both.
 */
export function createForge(config: AppConfig, log?: QuizForgeOptions["log"]): Forge | null {
  if (config.FORGE_KIND === "none") return null;
  if (config.FORGE_KIND === "quiz") {
    return createQuizForge({
      platformUrl: config.PLATFORM_URL,
      secret: config.CODESPACE_LAUNCH_SECRET,
      ...(log ? { log } : {}),
    });
  }
  if (config.FORGE_KIND === "github") return createUnconfiguredGithubForge();
  if (!config.FORGE_TOKEN) return null;
  return createForgejoForge({ baseUrl: config.FORGE_URL, token: config.FORGE_TOKEN });
}

/**
 * Whether the git channel must bind the gateway or not start at all (no
 * `0.0.0.0` fallback): in production, and for any instance other than a
 * workstation's unnamed one, where two bridges share the host (M6-04).
 */
export function strictGitBind(
  config: Pick<AppConfig, "NODE_ENV" | "CODESPACE_INSTANCE">,
): boolean {
  return config.NODE_ENV === "production" || config.CODESPACE_INSTANCE !== "default";
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
  /** Where the log lines go (tests read them back); stdout otherwise. */
  logStream?: LogStream;
}

export async function buildPortal(options: BuildOptions = {}): Promise<Portal> {
  const config = options.config ?? loadConfig();
  const handle = options.dbHandle ?? openDb(config.databasePath);
  const db = handle.db;

  const app = Fastify({
    logger: portalLogger(config.LOG_LEVEL, options.logStream),
    // `TRUSTED_PROXY_IPS` is the production setting: a list of front-end
    // addresses, so `request.ip` is the student's address and not Caddy's
    // (audit M1, classroom's docs/deploy.md § 6). It wins over the boolean `TRUST_PROXY`,
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
      instance: config.CODESPACE_INSTANCE,
      network: config.CODESPACE_NETWORK,
      gateway: config.CODESPACE_GATEWAY,
      seccompProfile: config.seccompProfile,
      apparmorProfile: config.CODESPACE_APPARMOR_PROFILE,
      image: config.CODESPACE_IMAGE,
      memory: config.CODESPACE_MEMORY,
      cpus: config.CODESPACE_CPUS,
      pidsLimit: config.CODESPACE_PIDS_LIMIT,
      cgroupParent: config.CODESPACE_CGROUP_PARENT,
      log: app.log,
    });

  const forge = createForge(config, app.log);
  const store = createPushEventStore(db);
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
          forgeAuthorization: (repo, owner, url) => forge.authorization(repo, owner, url),
          forgeSettle: (authorization) => forge.settle?.(authorization),
          // A closed workspace with nothing pending keeps no credential (ADR-078 §3).
          onSessionClosed: async (owner) => {
            if (forge.forget && !(await store.hasPending(owner.student, owner.assignment))) forge.forget(owner);
          },
        }
      : {}),
  });

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
  // The platform builds every `.seb` (D21, M6-07): the portal serves none and
  // has no start route of its own; an exam opens through `/launch`, where
  // this verifier runs once.
  const verifier = createSebVerifier({
    mode: config.SEB_VERIFIER,
    nodeEnv: config.NODE_ENV,
    url:
      config.SEB_PUBLIC_ORIGIN !== ""
        ? { publicOrigin: config.SEB_PUBLIC_ORIGIN }
        : { defaultProtocol: "http" as const },
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
      strictBind: strictGitBind(config),
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
  const app = Fastify({ logger: portalLogger("info") });
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
