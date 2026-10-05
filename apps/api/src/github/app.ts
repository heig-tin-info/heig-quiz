/**
 * GitHub App client (GH-01..03): authentication via a JWT signed with the
 * PEM private key, resolution of installations per organization. Lazy
 * initialization; an unconfigured App blocks neither boot nor /healthz.
 *
 * Ported from heig-classroom (`apps/server/src/github/`, sync point
 * `ab98cc0`) with the rest of this directory, same shape so that its fixes
 * can be forwarded (ADR-035); the GH-/GR-/NFR- ids in these comments are
 * classroom's requirement ids. This is Quiz's OWN App (D23): its id, key
 * and slug come from `GITHUB_*` (config.ts, N-SEC-16).
 *
 * Installation tokens live in memory only: `@octokit/auth-app` caches them
 * per installation, inside the `App` below, until shortly before their
 * one-hour expiry. Nothing here stores or logs one.
 */
import { existsSync, readFileSync } from "node:fs";

import { App, Octokit } from "octokit";

import type { AppConfig } from "../config.js";
import { tracked } from "../serviceHealth.js";

/** One `App` per configuration object: the process has one, the tests many. */
let cached: { config: AppConfig; app: App | null } | undefined;

/**
 * Throttling policy. Octokit's default waits out a rate limit and retries
 * once — until the quota resets for a primary limit, up to an hour. Right
 * for background jobs (provisioning, reconciliation); wrong for a read that
 * serves an HTTP request: on 2026-09-24 the detail view of Prog-C hung for
 * 35 minutes. Such reads pass `request: { noRateLimitWait: true }` and get
 * the 403/429 at once, then fall back to the stored state.
 */
type ThrottleOptions = {
  method: string;
  url: string;
  request: { retryCount: number; noRateLimitWait?: boolean };
};
function waitOutRateLimit(
  retryAfter: number,
  options: ThrottleOptions,
  octokit: Octokit,
  kind: string,
): boolean {
  const { method, url, request } = options;
  octokit.log.warn(`${kind} for request ${method} ${url} (retry after ${retryAfter} s)`);
  return !request.noRateLimitWait && request.retryCount === 0;
}
export const ThrottledOctokit: typeof Octokit = Octokit.defaults({
  throttle: {
    onRateLimit: (retryAfter: number, options: ThrottleOptions, octokit: Octokit) =>
      waitOutRateLimit(retryAfter, options, octokit, "Request quota exhausted"),
    onSecondaryRateLimit: (retryAfter: number, options: ThrottleOptions, octokit: Octokit) =>
      waitOutRateLimit(retryAfter, options, octokit, "SecondaryRateLimit detected"),
  },
});

/**
 * The App, or null when it is not configured: no App id, or no key file on
 * disk (production refuses the latter at boot, config.ts). `githubApp(config)
 * !== null` is THE test of "GitHub is on"; nothing else decides it.
 */
export function githubApp(config: AppConfig): App | null {
  if (cached?.config === config) return cached.app;
  const app =
    config.GITHUB_APP_ID !== "" &&
    config.GITHUB_APP_PRIVATE_KEY_PATH !== "" &&
    existsSync(config.GITHUB_APP_PRIVATE_KEY_PATH)
      ? new App({
          appId: config.GITHUB_APP_ID,
          privateKey: readFileSync(config.GITHUB_APP_PRIVATE_KEY_PATH, "utf8"),
          // The App's own user-to-server OAuth: the account link (M2-03).
          oauth: {
            clientId: config.GITHUB_APP_CLIENT_ID,
            clientSecret: config.GITHUB_APP_CLIENT_SECRET,
          },
          Octokit: ThrottledOctokit,
        })
      : null;
  cached = { config, app };
  return app;
}

/**
 * What a read serving an HTTP request passes as `request` (§3.1, #37): a
 * rate limit is answered at once, and the caller falls back to the stored
 * state. Background jobs pass nothing and wait it out once.
 */
export interface ReadOptions {
  noRateLimitWait?: boolean;
}
export const HTTP_READ: ReadOptions = { noRateLimitWait: true };

/**
 * `octokit` with every request answered at once on a rate limit (M3-06):
 * what a scheduled pass over many repositories uses, so that a quota
 * exhausted stops the pass — the next period resumes it — instead of
 * waiting up to an hour inside the task. The same instance underneath (its
 * hooks, its token); only `request` carries the option, so a helper handed
 * this client passes it on without knowing. Known limit: `paginate`,
 * `rest.*` and `graphql` stay bound to the original instance and do not
 * inherit it — no reconciliation helper uses them; one that would must take
 * `request` directly.
 */
export function failFast(octokit: Octokit): Octokit {
  return Object.create(octokit, { request: { value: octokit.request.defaults({ request: HTTP_READ }) } }) as Octokit;
}

/** The HTTP status GitHub answered with, when the error is an answer of GitHub's. */
export function githubStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** GitHub's all-zeros sha: a push's `after` deleting a branch, its `before` creating one. */
export function isZeroSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

/** `owner/name` as the REST API's two path parameters. */
export function ownerRepo(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf("/");
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

/**
 * Epoch ms when a request GitHub refused for its rate limit (a 403 or 429
 * with the quota exhausted, or a `retry-after`) may be made again; null for
 * any other failure. The live-state cache skips an installation until then
 * (`metrics.ts`); a background job is sent again at that time without
 * spending a retry (N-PERF-07, `modules/github/deliveries.ts`).
 */
export function rateLimitReset(err: unknown, now: number): number | null {
  const e = err as { status?: number; response?: { headers?: Record<string, string> } };
  if (e.status !== 403 && e.status !== 429) return null;
  const headers = e.response?.headers ?? {};
  if (headers["x-ratelimit-remaining"] === "0" && headers["x-ratelimit-reset"]) {
    return Number(headers["x-ratelimit-reset"]) * 1000;
  }
  if (headers["retry-after"]) return now + Number(headers["retry-after"]) * 1000;
  return null;
}

/**
 * One installation of Quiz's App on an organization, as GitHub describes it
 * (`GET /app/installations/{id}`, `/orgs/{org}/installation`, the listing).
 */
export interface AppInstallation {
  installationId: number;
  githubOrgId: number;
  login: string;
  /** `repository_selection: "all"`: the App reaches every repository (F-GH-03). */
  allRepositories: boolean;
  /**
   * GitHub's `suspended_at` is set: the installation exists but the App can
   * do nothing there (its tokens are refused) until it is unsuspended. Told
   * from a GONE installation (null), which is the App lost to the
   * organization (F-PROJ-18, M3-09b): a suspension is not.
   */
  suspended: boolean;
}

interface RawInstallation {
  id: number;
  account: { id?: number; login?: string; type?: string } | null;
  repository_selection?: string;
  suspended_at?: string | null;
}

/**
 * An organization's installation, or null for a user's or a malformed one.
 * A SUSPENDED one is returned as such (`suspended`): Quiz acts on it as on
 * none until it is unsuspended, but knows it is still there.
 */
function orgInstallation(data: RawInstallation): AppInstallation | null {
  const account = data.account;
  if (!account?.login || account.id === undefined || account.type !== "Organization") return null;
  return {
    installationId: data.id,
    githubOrgId: account.id,
    login: account.login,
    allRepositories: data.repository_selection === "all",
    suspended: Boolean(data.suspended_at),
  };
}

export interface InstallationClient {
  octokit: Octokit;
  token: string;
}

/** Octokit authenticated on an installation + token for git operations. */
export async function installationClient(
  config: AppConfig,
  installationId: number,
): Promise<InstallationClient> {
  const app = githubApp(config);
  if (!app) throw new Error("GitHub App is not configured (missing app id or PEM file)");
  // The token fetch is the App's own health: recorded for the services'
  // status (ADR-055 §6), by its outcome only — the token never leaves here.
  return tracked("github", async () => {
    const octokit = await app.getInstallationOctokit(installationId);
    const { token } = (await octokit.auth({ type: "installation" })) as { token: string };
    return { octokit, token };
  });
}

/**
 * Organizations where the App is installed (the connect sheet's picker),
 * every page, sorted by login; users' installations left out. Throws when
 * GitHub fails.
 */
export async function listInstalledOrgs(
  config: AppConfig,
  read: ReadOptions = {},
): Promise<AppInstallation[]> {
  const app = githubApp(config);
  if (!app) return [];
  const all = (await app.octokit.paginate(app.octokit.rest.apps.listInstallations, {
    per_page: 100,
    request: read,
  })) as RawInstallation[];
  return all
    .flatMap((raw) => orgInstallation(raw) ?? [])
    .sort((a, b) => a.login.localeCompare(b.login));
}

/** Does the organization exist on GitHub? Authenticated through the App
 *  JWT when configured (the anonymous quota is 60 req/h and exhausts fast);
 *  `null` = indeterminate (rate limit, network): let it through. */
export async function orgExistsOnGithub(
  login: string,
  config?: AppConfig,
  read: ReadOptions = {},
): Promise<boolean | null> {
  const app = config ? githubApp(config) : null;
  if (app) {
    try {
      await app.octokit.request("GET /orgs/{org}", {
        org: login,
        request: { retries: 0, ...read },
      });
      return true;
    } catch (err) {
      const status = githubStatus(err);
      if (status === 404) return false;
      // fall through to the anonymous lookup
    }
  }
  try {
    const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(login)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "heig-quiz" },
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * Billing plan of an installed organization (`free`, `team`, …). GitHub only
 * serves the `plan` field of GET /orgs/{org} to callers holding the App's
 * org Plan permission — i.e. the installation client, not the App JWT.
 * Null = indeterminate (permission not granted, API error): never warn on it.
 */
export async function fetchOrgPlan(
  config: AppConfig,
  installationId: number,
  orgLogin: string,
  read: ReadOptions = {},
): Promise<string | null> {
  try {
    const { octokit } = await installationClient(config, installationId);
    const { data } = await octokit.request("GET /orgs/{org}", { org: orgLogin, request: read });
    const plan = (data as { plan?: { name?: string } }).plan?.name;
    return plan ? plan.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Presence of the ANTHROPIC_API_KEY organization secret: without it the LLM
 * review tier dies at every deadline/milestone ("Could not resolve
 * authentication method", seen live 2026-07-14). Requires the App's org
 * Secrets read permission; null = indeterminate (permission not granted
 * yet, API error) — never warn on it. Presence only: the value's validity
 * still shows up at the first review run.
 */
export async function fetchOrgLlmSecret(
  config: AppConfig,
  installationId: number,
  orgLogin: string,
  read: ReadOptions = {},
): Promise<"ok" | "missing" | null> {
  try {
    const { octokit } = await installationClient(config, installationId);
    await octokit.request("GET /orgs/{org}/actions/secrets/{secret_name}", {
      org: orgLogin,
      secret_name: "ANTHROPIC_API_KEY",
      request: { retries: 0, ...read },
    });
    return "ok";
  } catch (err) {
    return githubStatus(err) === 404 ? "missing" : null;
  }
}

/**
 * GET /orgs/{org}/installation; null if the App is not installed there. The
 * login is only what GitHub resolves TODAY: the caller compares the
 * returned `githubOrgId` with the one it holds (a login can be reused by
 * another organization).
 */
export async function resolveOrgInstallation(
  config: AppConfig,
  orgLogin: string,
  read: ReadOptions = {},
): Promise<AppInstallation | null> {
  const app = githubApp(config);
  if (!app) return null;
  try {
    const { data } = await app.octokit.request("GET /orgs/{org}/installation", {
      org: orgLogin,
      request: read,
    });
    return orgInstallation(data as RawInstallation);
  } catch (err) {
    if (githubStatus(err) === 404) return null;
    throw err;
  }
}

/**
 * GET /app/installations/{id} with the App JWT: null when GitHub does not
 * know the installation (404) or it is not an organization's; any other
 * failure throws. The one proof the setup return accepts (N-SEC-17).
 */
export async function fetchInstallation(
  config: AppConfig,
  installationId: number,
  read: ReadOptions = {},
): Promise<AppInstallation | null> {
  const app = githubApp(config);
  if (!app) return null;
  try {
    const { data } = await app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
      request: read,
    });
    return orgInstallation(data as RawInstallation);
  } catch (err) {
    if (githubStatus(err) === 404) return null;
    throw err;
  }
}

/** One delivery attempt of the App's webhook, as `GET /app/hook/deliveries` lists it. */
export interface HookDelivery {
  /** The attempt's id, what a redelivery names. */
  id: number;
  /** `X-GitHub-Delivery`: the same for every attempt of one delivery. */
  guid: string;
  statusCode: number;
  redelivery: boolean;
  deliveredAt: Date;
}

interface RawHookDelivery {
  id: number;
  guid: string;
  status_code: number;
  redelivery: boolean;
  delivered_at: string;
}

/**
 * The App's latest webhook delivery attempts, newest first, one page of 100
 * (GH-62): where the reconciliation looks for failures. Empty when the App
 * has no webhook configured (GitHub's 404); any other failure throws. A
 * background call: a rate limit is waited out once.
 */
export async function recentHookDeliveries(config: AppConfig): Promise<HookDelivery[]> {
  const app = githubApp(config);
  if (!app) return [];
  try {
    const { data } = await app.octokit.request("GET /app/hook/deliveries", { per_page: 100 });
    return (data as RawHookDelivery[]).map((d) => ({
      id: d.id,
      guid: d.guid,
      statusCode: d.status_code,
      redelivery: d.redelivery,
      deliveredAt: new Date(d.delivered_at),
    }));
  } catch (err) {
    if (githubStatus(err) === 404) return [];
    throw err;
  }
}

/** Asks GitHub to deliver an attempt again (`POST /app/hook/deliveries/{id}/attempts`). */
export async function redeliverHookDelivery(config: AppConfig, id: number): Promise<void> {
  const app = githubApp(config);
  if (!app) return;
  await app.octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
    delivery_id: id,
  });
}
