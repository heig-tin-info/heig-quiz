/**
 * Portal configuration: environment variables validated at startup (immediate
 * failure), like `apps/api/src/config.ts` of Quiz.
 *
 * It lives under `auth/` for historical reasons (the V1 task's write scope);
 * it is re-exported by `server.ts`, which is the composition root.
 *
 * The portal has no login of its own (ADR-047, amendment of M6-03): a user
 * exists only through the platform's launch token, and the teachers see
 * sessions through the platform, which calls the service API.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { INSTANCE_PATTERN } from "../engine/index.js";

/**
 * Repository root: the first ancestor of this module that carries the
 * application's `package.json`. The relative paths of the configuration are
 * resolved against it, not against the launch directory: `infra/seccomp/...`
 * must designate the same file whether one starts from the root, from
 * `apps/codespace` (what `pnpm --filter` does) or from a script.
 *
 * The walk up is searched rather than counted: the compiled module lives in
 * `dist/auth/`, not in `src/auth/`, and a fixed number of `..` would designate
 * two different directories depending on whether `pnpm dev` or `pnpm start` is
 * run.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("application root not found (no package.json among the ancestors)");
}

function fromRepoRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot(), path);
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  /**
   * 3100 by default: the platform's API occupies 3000 and both run together
   * in development (docs/integration-classroom.md).
   */
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Public origin of the portal: the return link and SEB's allowed host. */
  PUBLIC_URL: z.string().default("http://localhost:3100"),
  DATABASE_PATH: z.string().default("./var/codespace.sqlite"),

  // --- Container engine (engine/) -----------------------------------------
  /**
   * Which portal this is, when several share one Podman engine (`prod` and
   * `staging` on the engine VM, M6-04). It names and labels the session
   * containers, and the engine lists only its own: two instances never reap
   * each other's sessions. Closed charset
   * (`INSTANCE_PATTERN` of `engine/`): lower-case letters and digits.
   */
  CODESPACE_INSTANCE: z
    .string()
    .regex(INSTANCE_PATTERN, "lower-case letters and digits, starting with a letter, at most 16")
    .default("default"),
  /** Always through the rootful socket, always `--remote` (setup-workstation.md). */
  PODMAN_URL: z.string().default("unix:///run/podman/podman.sock"),
  CODESPACE_NETWORK: z.string().default("codespace"),
  CODESPACE_GATEWAY: z.string().default("10.77.0.254"),
  CODESPACE_GIT_PORT: z.coerce.number().int().min(1).max(65535).default(9418),
  VOLUMES_ROOT: z.string().default("./var/volumes"),
  /** The project's seccomp profile; absolute path passed as is to Podman. */
  SECCOMP_PROFILE: z.string().default("./infra/seccomp/codespace.json"),
  /**
   * Name of the AppArmor profile loaded on the host, not a path: Podman
   * resolves a `--security-opt apparmor=<name>` against the profiles the
   * kernel has loaded. `infra/apparmor/codespace` is the source,
   * classroom's `deploy/bootstrap.sh` installs it into `/etc/apparmor.d/` and
   * classroom's `deploy/push.sh` reloads it.
   *
   * **Empty = the flag is not passed at all**, which is what a host without
   * AppArmor needs — the WSL2 development workstation, where `.env.example`
   * leaves it empty. On such a host Podman would refuse a profile name it
   * cannot find.
   */
  CODESPACE_APPARMOR_PROFILE: z.string().default("codespace"),
  CODESPACE_IMAGE: z.string().default("codespace/c-dev:4.137.0"),
  CODESPACE_MEMORY: z.string().default("1536m"),
  CODESPACE_CPUS: z.string().default("1"),
  CODESPACE_PIDS_LIMIT: z.coerce.number().int().min(16).default(256),

  // --- Session lifecycle (sessions/) ---------------------------------------
  /** Grace period after the last heartbeat before the container is destroyed. */
  SESSION_GRACE_MS: z.coerce.number().int().min(1000).default(10 * 60 * 1000),
  /** Period of the garbage collector. */
  SESSION_GC_INTERVAL_MS: z.coerce.number().int().min(1000).default(60 * 1000),
  /** Period of the shadow repository snapshots (analyse.md 3.3). */
  SHADOW_INTERVAL_MS: z.coerce.number().int().min(1000).default(3 * 60 * 1000),
  /** Maximum wait for the container's `/healthz` when a session starts. */
  SESSION_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),

  // --- Forge (git/relay.ts) -----------------------------------------------
  /**
   * Where pushes are relayed (ADR-078 §3). `quiz` — the default once the
   * platform integration is configured (`PLATFORM_URL` and
   * `CODESPACE_LAUNCH_SECRET` both set) — reaches GitHub with tokens Quiz
   * grants per repository; `none` otherwise (a push lands in `staging.git`
   * with its `PushEvent`, nothing is relayed), and settable explicitly.
   * `forgejo` is the development forge of `infra/compose.dev.yml`; `github`
   * without an App is the unconfigured forge (public clone URLs only).
   * Production refuses both, and `quiz` without an `https` `PLATFORM_URL`.
   */
  FORGE_KIND: z.enum(["quiz", "forgejo", "github", "none"]).optional(),
  FORGE_URL: z.string().default("http://localhost:3300"),
  FORGE_TOKEN: z.string().default(""),
  FORGE_USER: z.string().default("codespace"),
  /**
   * GitHub App credentials. **Refused at startup, in every environment**
   * (`loadConfig`): the portal holds no App credential at all (root
   * invariant 15, ADR-078 §1) — never heig-classroom's App, never Quiz's;
   * the `quiz` forge asks Quiz for a token per repository instead.
   */
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default(""),

  // --- Platform integration (classroom/) -----------------------------------
  /**
   * HS256 secret shared with the platform (`@quiz/contracts`
   * `codespace.ts`). **Empty = integration disabled**: `PUT
   * /api/assignments/:id`, `GET /api/assignments/:id/sessions` and `GET
   * /launch` are not registered and answer 404; the portal then opens no
   * session at all.
   *
   * Thirty-two characters at the very least: an HMAC-SHA256 brings nothing
   * below the size of its output block.
   */
  CODESPACE_LAUNCH_SECRET: z
    .string()
    .default("")
    .refine((v) => v === "" || v.length >= 32, {
      message: "CODESPACE_LAUNCH_SECRET must be at least 32 characters long",
    }),
  /**
   * Public origin of the platform (Quiz): `startURL` of the `.seb` files and
   * return link. `CLASSROOM_URL` is still read as an alias (`loadConfig`).
   */
  PLATFORM_URL: z.string().default("http://localhost:3000"),
  /**
   * Image given to a synchronized assignment whose `image` is `null`. Distinct
   * from `CODESPACE_IMAGE`, which is the **engine**'s fallback when a session
   * designates none.
   */
  CODESPACE_DEFAULT_IMAGE: z.string().default("codespace/c-dev:4.137.0"),

  // --- SEB (seb/) ----------------------------------------------------------
  // The `.seb` and its URL filter are the platform's (D21, M6-07): Quiz's
  // `SEB_EXTRA_ALLOWED_HOSTS` replaces the portal's.
  SEB_VERIFIER: z.enum(["real", "simulated"]).default("simulated"),
  /**
   * Origin on which SEB computes its hashes. Empty = rebuilt from `Host`,
   * acceptable in development over plain HTTP only (analyse.md 4.6).
   */
  SEB_PUBLIC_ORIGIN: z.string().default(""),
  /** HMAC secret of the `exam_session` cookie. */
  EXAM_COOKIE_SECRET: z.string().min(16).default("dev-exam-cookie-secret-change-me"),
  EXAM_COOKIE_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(4 * 60 * 60 * 1000),

  /**
   * Fastify's `trustProxy`. **Development only**: it makes `request.ip`
   * controllable through `X-Forwarded-For`, which an end-to-end run (heig-classroom's `scripts/e2e.ts`, not imported: M6-04) needs in
   * order to simulate a second workstation. In production, the portal sits
   * behind a controlled front end or behind nothing at all.
   */
  TRUST_PROXY: z
    .string()
    .default("")
    .transform((v) => v === "1" || v === "true"),
  /**
   * Addresses (or CIDRs) of the front ends allowed to speak for their client,
   * comma-separated, passed as an array to Fastify's `trustProxy`. This is the
   * **production** setting, and the only one: Fastify then walks the
   * `X-Forwarded-For` chain for a hop whose address is in this list and stops
   * at the first one that is not, so a client forging the header from the
   * outside gains nothing — its own hop to Caddy is not in the list.
   *
   * Behind the Caddy of classroom's `deploy/Caddyfile`, which reverse-proxies to
   * 127.0.0.1:3100 and appends `X-Forwarded-For` by default, the value is
   * `127.0.0.1`. Empty (no front end), `request.ip` is the socket address, as
   * it should be.
   *
   * Why it is not optional in production: the `exam_session` cookie is bound
   * to `request.ip` (analyse.md D5, classroom's docs/deploy.md § 6). With every request
   * arriving from 127.0.0.1, that binding compares 127.0.0.1 with 127.0.0.1
   * for everyone, and a stolen cookie replayed from another workstation is
   * accepted. `loadConfig` refuses to start rather than run an exam on a check
   * that cannot fire.
   */
  TRUSTED_PROXY_IPS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h !== ""),
    ),
});

export type ForgeKind = "quiz" | "forgejo" | "github" | "none";

export type AppConfig = Omit<z.infer<typeof EnvSchema>, "FORGE_KIND"> & {
  /** Resolved at load time: the explicit value, else `quiz` with the platform configured, else `none`. */
  FORGE_KIND: ForgeKind;
  /** Made absolute at load time, relative to the repository root. */
  volumesRoot: string;
  seccompProfile: string;
  databasePath: string;
};

/**
 * `FORGE_KIND` left unset (ADR-078 §3): `quiz` once the platform
 * integration is configured — `PLATFORM_URL` (or its alias) given and the
 * shared secret set —, `none` otherwise. The URL's built-in default does not
 * count: a portal that never named its platform relays nothing.
 */
export function defaultForgeKind(env: NodeJS.ProcessEnv, secret: string): ForgeKind {
  const platform = (env["PLATFORM_URL"] ?? "").trim();
  return platform !== "" && secret !== "" ? "quiz" : "none";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // `PLATFORM_URL` replaced `CLASSROOM_URL` (M6-03); the old name is still
  // read when the new one is absent, so an existing env file keeps working.
  const aliased =
    env["PLATFORM_URL"] === undefined && env["CLASSROOM_URL"] !== undefined
      ? { ...env, PLATFORM_URL: env["CLASSROOM_URL"] }
      : env;
  const parsed = EnvSchema.safeParse(aliased);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" ; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const data = parsed.data;
  // Root invariant 15 and ADR-078 §1: the portal holds no GitHub App
  // credential, in any environment — never heig-classroom's App, and Quiz's
  // key stays on the app VM. Refused in development too, so a copied
  // `/etc/codespace/env` cannot carry one over.
  for (const key of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_PATH"] as const) {
    if (data[key] !== "") {
      throw new Error(
        `Invalid configuration: ${key} is set, but the portal holds no GitHub App ` +
          "(ADR-078: the quiz forge asks Quiz for a token scoped to one repository)",
      );
    }
  }
  const FORGE_KIND = data.FORGE_KIND ?? defaultForgeKind(aliased, data.CODESPACE_LAUNCH_SECRET);
  if (data.NODE_ENV === "production") {
    // A development secret in production is a deployment mistake, not a
    // setting.
    if (data.EXAM_COOKIE_SECRET.includes("change-me")) {
      throw new Error(
        "Invalid configuration: development EXAM_COOKIE_SECRET forbidden in production",
      );
    }
    if (data.TRUST_PROXY) {
      throw new Error("Invalid configuration: TRUST_PROXY is a development setting");
    }
    // Audit M1 of 2026-09-18, classroom's docs/deploy.md § 6. Behind a front end without
    // this list, `request.ip` is the front end's address for every student and
    // the address binding of the `exam_session` cookie can never fire. It is
    // written as a conjunction with the verifier rather than alone because it
    // is the *exam* that cannot be run without it; `SEB_VERIFIER=simulated` is
    // already refused above, so in practice the list is required, and that is
    // the intent: a portal reachable from the outside sits behind Caddy.
    if (data.TRUSTED_PROXY_IPS.length === 0 && data.SEB_VERIFIER === "real") {
      throw new Error(
        "Invalid configuration: TRUSTED_PROXY_IPS is required in production " +
          "(127.0.0.1 behind a local reverse proxy such as Caddy); without it " +
          "the exam cookie's address binding is void",
      );
    }
    // Invariant 8: the deep guard is in `createSebVerifier`; this one makes
    // startup fail earlier and with a configuration message.
    if (data.SEB_VERIFIER === "simulated") {
      throw new Error("Invalid configuration: SEB_VERIFIER=simulated forbidden in production");
    }
    if (data.SEB_PUBLIC_ORIGIN === "") {
      throw new Error("Invalid configuration: SEB_PUBLIC_ORIGIN is required in production");
    }
    if (data.CODESPACE_LAUNCH_SECRET.includes("change-me")) {
      throw new Error(
        "Invalid configuration: development CODESPACE_LAUNCH_SECRET forbidden in production",
      );
    }
    // ADR-078 §3: Forgejo's token would sit on the engine VM, and the
    // unconfigured GitHub forge relays nothing.
    if (FORGE_KIND === "forgejo" || FORGE_KIND === "github") {
      throw new Error(`Invalid configuration: FORGE_KIND=${FORGE_KIND} is a development forge, forbidden in production`);
    }
    if (FORGE_KIND === "quiz" && !/^https:\/\//.test(data.PLATFORM_URL)) {
      throw new Error("Invalid configuration: FORGE_KIND=quiz requires PLATFORM_URL over https in production");
    }
  }
  if (FORGE_KIND === "quiz" && data.CODESPACE_LAUNCH_SECRET === "") {
    throw new Error("Invalid configuration: FORGE_KIND=quiz requires CODESPACE_LAUNCH_SECRET (it signs the token requests)");
  }
  return {
    ...data,
    FORGE_KIND,
    volumesRoot: fromRepoRoot(data.VOLUMES_ROOT),
    seccompProfile: fromRepoRoot(data.SECCOMP_PROFILE),
    databasePath: fromRepoRoot(data.DATABASE_PATH),
  };
}
