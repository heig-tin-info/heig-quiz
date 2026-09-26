import { resolve } from "node:path";

import { z } from "zod";

/**
 * Configuration via environment variables, validated at startup (fail-fast).
 * Secrets only travel through the environment (ADR-010).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** ADR-001: `all` (default) | `web` | `worker`; roles can split without code changes. */
  WORKER_MODE: z.enum(["all", "web", "worker"]).default("all"),
  /**
   * Either a real PostgreSQL URL (`postgres://…`, production and CI) or
   * `pglite://<dir>` — an embedded Postgres persisted on disk, which is what
   * makes `pnpm dev` work on a laptop without Docker. The directory is
   * relative to the working directory unless absolute.
   */
  DATABASE_URL: z.string().default("pglite://.data/pglite"),
  /** Apply Drizzle migrations at startup (container deployment, and dev). */
  MIGRATE_ON_START: z
    .string()
    .default("1")
    .transform((v) => v === "1" || v === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /** Public URL of the portal (base for OIDC/OAuth redirect URIs). */
  PUBLIC_URL: z.string().default("http://localhost:3000"),

  /**
   * Where a BROWSER reaches the SPA — the base of the poll join link behind
   * the QR code (F-LIVE-13, ADR-014).
   *
   * Empty means `PUBLIC_URL`, which is already the right answer in both
   * shipped setups: in production the monolith serves the built SPA itself,
   * and in development `.env.example` points `PUBLIC_URL` at the Vite origin
   * that proxies `/app`. Set it only when the two differ — typically
   * `WEB_URL=http://<lan-ip>:5173`, so a real phone can scan the code
   * instead of `localhost`.
   */
  WEB_URL: z.string().default(""),

  /**
   * The hosts whose Client ID Metadata Documents the OAuth server fetches
   * (ADR-023): an MCP client identified by an `https://` client_id is only
   * believed when that URL is on one of these hosts, so the server never
   * fetches an address a stranger chose. Comma-separated host names. Any
   * other client registers itself instead (RFC 7591).
   */
  OAUTH_CIMD_HOSTS: z.string().default("claude.ai,claude.com,chatgpt.com"),

  /**
   * The addresses Caddy reaches the API from — and NOTHING else.
   *
   * `req.ip` is the room restriction of F-EVAL-12 and the address the journal
   * records, so it must be the address the reverse proxy actually saw. Caddy
   * APPENDS to `X-Forwarded-For`, so the right-most entry is the real one and
   * the left-most is whatever the client typed: fastify walks the chain from
   * the socket and stops at the first hop that is not trusted, which gives
   * the right answer exactly when this list holds the proxy and no client.
   *
   * Comma-separated addresses, CIDRs or the names `loopback`, `linklocal`,
   * `uniquelocal`. The default covers both shipped deployments: a native
   * Caddy on `localhost:3000` and the container of `compose.prod.yml`, whose
   * peer is the Docker bridge gateway. Never add a range a STUDENT machine
   * can sit on — that is what would make the header forgeable again.
   */
  TRUSTED_PROXIES: z.string().min(1).default("loopback,172.16.0.0/12"),

  /** Directory of the built SPA (apps/web/dist); empty = API only (Vite dev). */
  STATIC_DIR: z.string().default(""),

  /**
   * Where uploaded question images live (F-QST-06). Files are named after
   * their sha256, so the directory is content-addressed and a backup is a
   * plain `rsync`. Relative to the working directory unless absolute.
   */
  ASSETS_DIR: z.string().default(".data/assets"),
  /** Hard cap on one uploaded image, in bytes (PLAN-MVP §4.2: 5 MB). */
  ASSETS_MAX_BYTES: z.coerce.number().int().min(1024).max(50_000_000).default(5_000_000),

  /**
   * Skip the job queue entirely. The tests point the API at a database that
   * is not there on purpose (`app.test.ts` checks that /healthz degrades
   * instead of crashing), and pg-boss answers that by retrying the
   * connection and printing an ECONNREFUSED stack trace every time. There is
   * nothing to diagnose in those traces and they drown the real output, so
   * the test helpers set this flag and `startJobs` returns cleanly.
   */
  JOBS_DISABLED: z
    .string()
    .default("")
    .transform((v) => v === "1" || v === "true"),

  /** Deadline ticker period, in milliseconds (docs/spec/05, 5.4). */
  TICK_MS: z.coerce.number().int().min(100).max(600_000).default(1000),

  // --- OIDC: local Keycloak in dev, Switch edu-ID in production. ---
  OIDC_ISSUER: z.string().default("http://localhost:8080/realms/quiz-dev"),
  OIDC_CLIENT_ID: z.string().default("quiz"),
  OIDC_CLIENT_SECRET: z.string().default("dev-secret-not-for-production"),
  /**
   * `private_key_jwt` client authentication (recommended by SWITCH):
   * path to a PKCS8 private key whose public JWK is registered in the
   * Resource Registry. Empty = client_secret (dev Keycloak).
   */
  OIDC_PRIVATE_KEY_PATH: z.string().default(""),
  OIDC_PRIVATE_KEY_KID: z.string().default("quiz-eduid-2026"),

  /**
   * Development login (`GET /app/auth/dev`): a persona picker that opens a
   * normal session without any identity provider. NEVER in production — see
   * the refusal below, which is the same mechanism as the dev-value one.
   */
  AUTH_DEV_LOGIN: z
    .string()
    .default("")
    .transform((v) => v === "1" || v === "true"),

  /** Signs the login state cookies (not the sessions, which live in the database). */
  COOKIE_SECRET: z.string().min(16).default("dev-cookie-secret-change-me"),
  /**
   * Session idle timeout (12 h by default). Sessions renew while in use
   * (sliding expiry), so this bounds the inactivity gap, not the total
   * signed-in time. 720 h = 30 days.
   */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  /**
   * Code runner (PLAN-MVP §1.7, decision D14). `stub` everywhere until a
   * machine with Podman exists: `run()` throws `RunnerUnavailable`, grading
   * degrades to a proposed grade, and nothing blocks. `http` talks to the
   * runner service and then `RUNNER_URL` is required.
   */
  RUNNER_MODE: z.enum(["stub", "http"]).default("stub"),
  RUNNER_URL: z.string().default(""),
  /**
   * Shared secret sent as `Authorization: Bearer` to the runner (ADR-016).
   * The runner lives on another machine in production, behind TLS: the
   * token is what keeps it from being a free compute service for whoever
   * finds the address. Required in production when `RUNNER_MODE=http`.
   */
  RUNNER_TOKEN: z.string().default(""),
  /** Wall-clock budget of one runner call, compilation and every case included. */
  RUNNER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

  /**
   * Bearer token for `GET /metrics` (Prometheus, N-OPS). Empty — the default
   * — means the endpoint is open to an ADMIN SESSION only; it is never
   * public, because the default metrics carry the process's command line,
   * versions and memory profile.
   */
  METRICS_TOKEN: z.string().default(""),

  /**
   * Super administrator: the only email managed through the environment.
   * Teachers are managed in the database, from the admin screen.
   */
  SUPER_ADMIN_EMAIL: z.string().default(""),

  /**
   * Who may sign in (ADR-028): a comma-separated list of addresses, and of
   * `@domain` entries matching a whole domain. Empty — the default, and
   * production — admits everyone the IdP authenticates. The staging
   * environment sets it, so that a copy of the production data is reached by
   * the developers only. The super administrator is always admitted.
   */
  LOGIN_ALLOWLIST: z.string().default(""),

  // --- Notification channels (ADR-030) ---

  /**
   * Transactional e-mail through Scaleway TEM, the provider of heig-classroom.
   * Without BOTH credentials the mailer runs dry: every e-mail is logged,
   * none is sent — which is what development and the tests want.
   */
  SCW_SECRET_KEY: z.string().default(""),
  SCW_DEFAULT_PROJECT_ID: z.string().default(""),
  MAIL_FROM: z.string().default("no-reply@chevallier.io"),
  MAIL_FROM_NAME: z.string().default("HEIG Quiz"),
  MAIL_REGION: z.string().default("fr-par"),

  /**
   * Microsoft Teams: ONE multi-tenant Entra application that is at once the
   * "Connect Teams" sign-in, the Graph client that installs the app for a
   * user, and the bot that writes to them (docs/development/teams.md). The channel exists
   * only when the three are set; otherwise the settings say Teams is not
   * available and its routes answer 503.
   */
  TEAMS_CLIENT_ID: z.string().default(""),
  TEAMS_CLIENT_SECRET: z.string().default(""),
  /** The id of the Teams app in the tenants' catalogs (its manifest id once published). */
  TEAMS_APP_ID: z.string().default(""),
  /**
   * The tenant that issues the bot's Bot Connector token: `botframework.com`
   * for a multi-tenant bot, the home tenant id for a single-tenant one.
   */
  TEAMS_BOT_TENANT: z.string().default("botframework.com"),
  /** Bot Connector endpoint for Teams; the global one routes to every region. */
  TEAMS_SERVICE_URL: z.string().default("https://smba.trafficmanager.net/teams"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/** `pglite://<dir>` → the resolved data directory; null for a real Postgres. */
export function pgliteDir(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith("pglite://")) return null;
  const raw = databaseUrl.slice("pglite://".length) || ".data/pglite";
  return resolve(raw);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === "production") {
    // With `private_key_jwt` (edu-ID) the client secret is never sent, so its
    // dev default is not a secret in use and is not what to refuse.
    const secretsInUse = [
      ...(parsed.data.OIDC_PRIVATE_KEY_PATH
        ? []
        : [["OIDC_CLIENT_SECRET", "not-for-production"] as const]),
      ["COOKIE_SECRET", "change-me"] as const,
    ];
    for (const [key, marker] of secretsInUse) {
      if (parsed.data[key].includes(marker)) {
        throw new Error(`Invalid configuration: dev ${key} forbidden in production`);
      }
    }
    // A persona picker in production is an open door, whatever the reason
    // given for turning it on: refuse to boot rather than serve it.
    if (parsed.data.AUTH_DEV_LOGIN) {
      throw new Error("Invalid configuration: dev AUTH_DEV_LOGIN forbidden in production");
    }
    // The embedded database is a single-process file store with no backup
    // path: it is a development convenience, never a deployment.
    if (pgliteDir(parsed.data.DATABASE_URL)) {
      throw new Error("Invalid configuration: dev DATABASE_URL (pglite) forbidden in production");
    }
  }
  // `http` without an address is a runner that is silently never called: the
  // process refuses to start rather than grade every code question by hand
  // without saying so.
  if (parsed.data.RUNNER_MODE === "http" && parsed.data.RUNNER_URL.trim() === "") {
    throw new Error("Invalid configuration: RUNNER_URL is required when RUNNER_MODE=http");
  }
  // A runner reached over the network without a token would answer anyone:
  // in production the two sides must share one (ADR-016).
  if (
    parsed.data.NODE_ENV === "production" &&
    parsed.data.RUNNER_MODE === "http" &&
    parsed.data.RUNNER_TOKEN.trim() === ""
  ) {
    throw new Error("Invalid configuration: RUNNER_TOKEN is required when RUNNER_MODE=http");
  }
  return {
    ...parsed.data,
    // Empty means "the SPA is served where the API is" (production).
    WEB_URL: (parsed.data.WEB_URL || parsed.data.PUBLIC_URL).replace(/\/+$/, ""),
    PUBLIC_URL: parsed.data.PUBLIC_URL.replace(/\/+$/, ""),
    // Made absolute at load time, like the PEM path below: the asset store
    // must not follow the process around.
    ASSETS_DIR: resolve(parsed.data.ASSETS_DIR),
    RUNNER_URL: parsed.data.RUNNER_URL.trim().replace(/\/+$/, ""),
    RUNNER_TOKEN: parsed.data.RUNNER_TOKEN.trim(),
    SCW_SECRET_KEY: parsed.data.SCW_SECRET_KEY.trim(),
    SCW_DEFAULT_PROJECT_ID: parsed.data.SCW_DEFAULT_PROJECT_ID.trim(),
    TEAMS_CLIENT_ID: parsed.data.TEAMS_CLIENT_ID.trim(),
    TEAMS_CLIENT_SECRET: parsed.data.TEAMS_CLIENT_SECRET.trim(),
    TEAMS_APP_ID: parsed.data.TEAMS_APP_ID.trim(),
    TEAMS_SERVICE_URL: parsed.data.TEAMS_SERVICE_URL.trim().replace(/\/+$/, ""),
    SUPER_ADMIN_EMAIL: parsed.data.SUPER_ADMIN_EMAIL.trim().toLowerCase(),
    LOGIN_ALLOWLIST: parsed.data.LOGIN_ALLOWLIST.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e !== "")
      .join(","),
    // PEM path made absolute at load time: the process no longer depends on
    // its launch directory (ADR-010, secret in a file).
    OIDC_PRIVATE_KEY_PATH: parsed.data.OIDC_PRIVATE_KEY_PATH
      ? resolve(parsed.data.OIDC_PRIVATE_KEY_PATH)
      : "",
  };
}

/** Scaleway credentials present: e-mails are really sent (otherwise logged). */
export function mailEnabled(
  config: Pick<AppConfig, "SCW_SECRET_KEY" | "SCW_DEFAULT_PROJECT_ID">,
): boolean {
  return config.SCW_SECRET_KEY !== "" && config.SCW_DEFAULT_PROJECT_ID !== "";
}

/** The Teams channel exists: its Entra application is configured (ADR-030). */
export function teamsEnabled(
  config: Pick<AppConfig, "TEAMS_CLIENT_ID" | "TEAMS_CLIENT_SECRET" | "TEAMS_APP_ID">,
): boolean {
  return config.TEAMS_CLIENT_ID !== "" && config.TEAMS_CLIENT_SECRET !== "" && config.TEAMS_APP_ID !== "";
}

/**
 * Whether a login revealing `emails` (normalized) may open a session. An
 * empty allowlist admits everyone; otherwise one address must be listed, or
 * belong to a listed `@domain`, or be the super administrator's.
 */
export function loginAllowed(config: AppConfig, emails: readonly string[]): boolean {
  if (config.LOGIN_ALLOWLIST === "") return true;
  const entries = new Set(config.LOGIN_ALLOWLIST.split(","));
  if (config.SUPER_ADMIN_EMAIL) entries.add(config.SUPER_ADMIN_EMAIL);
  return emails.some((email) => {
    const at = email.lastIndexOf("@");
    return entries.has(email) || (at > 0 && entries.has(email.slice(at)));
  });
}
