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
   * Super administrator: the only email managed through the environment.
   * Teachers are managed in the database, from the admin screen.
   */
  SUPER_ADMIN_EMAIL: z.string().default(""),
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
    for (const [key, marker] of [
      ["OIDC_CLIENT_SECRET", "not-for-production"],
      ["COOKIE_SECRET", "change-me"],
    ] as const) {
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
  return {
    ...parsed.data,
    // Made absolute at load time, like the PEM path below: the asset store
    // must not follow the process around.
    ASSETS_DIR: resolve(parsed.data.ASSETS_DIR),
    SUPER_ADMIN_EMAIL: parsed.data.SUPER_ADMIN_EMAIL.trim().toLowerCase(),
    // PEM path made absolute at load time: the process no longer depends on
    // its launch directory (ADR-010, secret in a file).
    OIDC_PRIVATE_KEY_PATH: parsed.data.OIDC_PRIVATE_KEY_PATH
      ? resolve(parsed.data.OIDC_PRIVATE_KEY_PATH)
      : "",
  };
}
