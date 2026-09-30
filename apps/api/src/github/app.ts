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

export interface OrgInstallation {
  installationId: number;
  githubOrgId: number;
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

/** Organizations where the App is installed (classroom creation dropdown). */
export async function listInstalledOrgs(config: AppConfig): Promise<string[]> {
  const app = githubApp(config);
  if (!app) return [];
  const logins: string[] = [];
  for await (const { installation } of app.eachInstallation.iterator()) {
    const account = installation.account as { login?: string; type?: string } | null;
    if (account?.login && account.type === "Organization") logins.push(account.login);
  }
  return logins.sort();
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
      const status = (err as { status?: number }).status;
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
    return (err as { status?: number }).status === 404 ? "missing" : null;
  }
}

/** GET /orgs/{org}/installation; null if the App is not installed there. */
export async function resolveOrgInstallation(
  config: AppConfig,
  orgLogin: string,
  read: ReadOptions = {},
): Promise<OrgInstallation | null> {
  const app = githubApp(config);
  if (!app) return null;
  try {
    const { data } = await app.octokit.request("GET /orgs/{org}/installation", {
      org: orgLogin,
      request: read,
    });
    return {
      installationId: data.id,
      githubOrgId: (data.account as { id: number }).id,
    };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/**
 * One installation of Quiz's App on an organization, as the App JWT reads it
 * (Quiz addition, M2-02): what the setup return verifies, the organization
 * listing, and the healing's "installed on every repository" check.
 */
export interface AppInstallation extends OrgInstallation {
  login: string;
  /** `repository_selection: "all"`: the App reaches every repository (F-GH-03). */
  allRepositories: boolean;
}

interface RawInstallation {
  id: number;
  account: { id?: number; login?: string; type?: string } | null;
  repository_selection?: string;
}

function orgInstallation(data: RawInstallation): AppInstallation | null {
  const account = data.account;
  if (!account?.login || account.id === undefined || account.type !== "Organization") return null;
  return {
    installationId: data.id,
    githubOrgId: account.id,
    login: account.login,
    allRepositories: data.repository_selection === "all",
  };
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
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** Every organization installation of the App, all pages; throws when GitHub fails. */
export async function listInstallations(
  config: AppConfig,
  read: ReadOptions = {},
): Promise<AppInstallation[]> {
  const app = githubApp(config);
  if (!app) return [];
  const all: RawInstallation[] = [];
  for (let page = 1; ; page += 1) {
    const { data } = await app.octokit.request("GET /app/installations", {
      per_page: 100,
      page,
      request: read,
    });
    all.push(...(data as RawInstallation[]));
    if (data.length < 100) break;
  }
  return all.flatMap((raw) => orgInstallation(raw) ?? []);
}
