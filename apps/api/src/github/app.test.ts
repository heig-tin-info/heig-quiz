import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import {
  fetchOrgLlmSecret,
  fetchOrgPlan,
  githubApp,
  installationClient,
  listInstalledOrgs,
  orgExistsOnGithub,
  resolveOrgInstallation,
  ThrottledOctokit,
} from "./app.js";

/** A fetch that answers "quota exhausted, resets in an hour", then 200. */
function quotaFetch() {
  let calls = 0;
  const fetch = vi.fn(async () => {
    calls += 1;
    if (calls > 1) return new Response("[]", { status: 200 });
    return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
  });
  return fetch;
}

describe("ThrottledOctokit", () => {
  const log = { debug() {}, info() {}, warn() {}, error() {} };

  it("fails at once on an exhausted quota when the request opts out of waiting", async () => {
    const fetch = quotaFetch();
    const octokit = new ThrottledOctokit({ request: { fetch }, log });
    const started = Date.now();
    await expect(
      octokit.request("GET /repos/{owner}/{repo}/commits", {
        owner: "o",
        repo: "r",
        request: { retries: 0, noRateLimitWait: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("still waits out the limit for other requests (background jobs)", async () => {
    const fetch = quotaFetch();
    const octokit = new ThrottledOctokit({ request: { fetch }, log });
    const warn = vi.spyOn(octokit.log, "warn");
    const pending = octokit
      .request("GET /repos/{owner}/{repo}/commits", { owner: "o", repo: "r" })
      .catch(() => undefined);
    // The retry is scheduled an hour out: the request is still pending.
    const raced = await Promise.race([
      pending.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("waiting"), 300)),
    ]);
    expect(raced).toBe("waiting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Request quota exhausted"));
  });
});

/*
 * The App itself, against a fake GitHub: a real RSA key signs the App JWT,
 * and a stubbed global fetch answers the few routes these adapters call. No
 * network is ever reached.
 */
type Route = (url: URL, init: RequestInit) => Response | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("the App (Quiz's own, D23)", () => {
  const dir = mkdtempSync(join(tmpdir(), "quiz-app-test-"));
  const pem = join(dir, "app.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(pem, privateKey.export({ type: "pkcs1", format: "pem" }));

  let routes: Route[] = [];
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    for (const route of routes) {
      const res = route(url, { ...init, method });
      if (res) return res;
    }
    return json({ message: "Not Found" }, 404);
  });
  const on =
    (method: string, path: string, answer: () => Response): Route =>
    (url, init) =>
      init.method === method && url.pathname === path ? answer() : undefined;
  const token = on("POST", "/app/installations/42/access_tokens", () =>
    json({ token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201),
  );

  beforeEach(() => {
    vi.stubGlobal("fetch", fetch);
    fetch.mockClear();
    routes = [];
    calls.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // A fresh configuration object per test: `githubApp` keeps one App per object.
  const configured = () =>
    loadConfig({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY_PATH: pem, GITHUB_APP_SLUG: "heig-quiz" });

  it("is off with no GITHUB_* set, and every adapter says so without a call", async () => {
    const off = loadConfig({});
    expect(githubApp(off)).toBeNull();
    expect(await listInstalledOrgs(off)).toEqual([]);
    expect(await resolveOrgInstallation(off, "heig-tin-info")).toBeNull();
    expect(await fetchOrgPlan(off, 42, "heig-tin-info")).toBeNull();
    await expect(installationClient(off, 42)).rejects.toThrow(/not configured/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays off when the key file is missing outside production", () => {
    const config = loadConfig({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY_PATH: join(dir, "none.pem") });
    expect(githubApp(config)).toBeNull();
  });

  it("resolves an organization's installation, null when the App is not there", async () => {
    const config = configured();
    routes = [on("GET", "/orgs/heig-tin-info/installation", () => json({ id: 42, account: { id: 7 } }))];
    expect(await resolveOrgInstallation(config, "heig-tin-info")).toEqual({ installationId: 42, githubOrgId: 7 });
    expect(await resolveOrgInstallation(config, "elsewhere")).toBeNull();
    // Signed with the App JWT, not anonymous.
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^bearer ey/i);
  });

  it("keeps an installation token in memory: a second client asks GitHub for none", async () => {
    const config = configured();
    routes = [token];
    const first = await installationClient(config, 42);
    const second = await installationClient(config, 42);
    expect(first.token).toBe("ghs_fake");
    expect(second.token).toBe("ghs_fake");
    expect(calls.filter((c) => c.endsWith("/access_tokens"))).toHaveLength(1);
  });

  it("lists the organizations where the App is installed, users left out", async () => {
    routes = [
      on("GET", "/app/installations", () =>
        json([
          { id: 1, account: { login: "zeta-org", type: "Organization" } },
          { id: 2, account: { login: "someone", type: "User" } },
          { id: 3, account: { login: "alpha-org", type: "Organization" } },
        ]),
      ),
    ];
    expect(await listInstalledOrgs(configured())).toEqual(["alpha-org", "zeta-org"]);
  });

  it("tells whether an organization exists, through the App", async () => {
    const config = configured();
    routes = [on("GET", "/orgs/heig-tin-info", () => json({ login: "heig-tin-info" }))];
    expect(await orgExistsOnGithub("heig-tin-info", config)).toBe(true);
    expect(await orgExistsOnGithub("no-such-org", config)).toBe(false);
  });

  it("reads the organization's plan with the installation, null when unreadable", async () => {
    const config = configured();
    routes = [token, on("GET", "/orgs/heig-tin-info", () => json({ plan: { name: "Free" } }))];
    expect(await fetchOrgPlan(config, 42, "heig-tin-info")).toBe("free");
    routes = [token, on("GET", "/orgs/heig-tin-info", () => json({ login: "heig-tin-info" }))];
    expect(await fetchOrgPlan(config, 42, "heig-tin-info")).toBeNull();
  });

  it("probes the LLM secret: ok, missing, or indeterminate", async () => {
    const config = configured();
    const secret = "/orgs/heig-tin-info/actions/secrets/ANTHROPIC_API_KEY";
    routes = [token, on("GET", secret, () => json({ name: "ANTHROPIC_API_KEY" }))];
    expect(await fetchOrgLlmSecret(config, 42, "heig-tin-info")).toBe("ok");
    routes = [token];
    expect(await fetchOrgLlmSecret(config, 42, "heig-tin-info")).toBe("missing");
    routes = [token, on("GET", secret, () => json({ message: "Resource not accessible by integration" }, 403))];
    expect(await fetchOrgLlmSecret(config, 42, "heig-tin-info")).toBeNull();
  });
});
