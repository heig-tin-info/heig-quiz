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
import { appKey, fakeGithub, json, on } from "./testing.js";

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
describe("the App (Quiz's own, D23)", () => {
  const key = appKey();
  const pem = key.pem;
  const gh = fakeGithub();
  const token = on("POST", "/app/installations/42/access_tokens", () =>
    json({ token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201),
  );

  beforeEach(() => {
    vi.stubGlobal("fetch", gh.fetch);
    gh.reset();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => key.remove());

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
    expect(gh.calls).toEqual([]);
  });

  it("stays off when the key file is missing outside production", () => {
    const config = loadConfig({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY_PATH: `${pem}.missing` });
    expect(githubApp(config)).toBeNull();
  });

  it("resolves an organization's installation, null when the App is not there", async () => {
    const config = configured();
    gh.routes = [
      on("GET", "/orgs/heig-tin-info/installation", () =>
        json({
          id: 42,
          account: { id: 7, login: "heig-tin-info", type: "Organization" },
          repository_selection: "all",
        }),
      ),
    ];
    expect(await resolveOrgInstallation(config, "heig-tin-info")).toEqual({
      installationId: 42,
      githubOrgId: 7,
      login: "heig-tin-info",
      allRepositories: true,
    });
    expect(await resolveOrgInstallation(config, "elsewhere")).toBeNull();
    // Signed with the App JWT, not anonymous.
    const init = gh.inits[0]!;
    expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^bearer ey/i);
  });

  it("keeps an installation token in memory: a second client asks GitHub for none", async () => {
    const config = configured();
    gh.routes = [token];
    const first = await installationClient(config, 42);
    const second = await installationClient(config, 42);
    expect(first.token).toBe("ghs_fake");
    expect(second.token).toBe("ghs_fake");
    expect(gh.calls.filter((c) => c.endsWith("/access_tokens"))).toHaveLength(1);
  });

  it("lists the organizations where the App is installed, users left out", async () => {
    gh.routes = [
      on("GET", "/app/installations", () =>
        json([
          { id: 1, account: { id: 11, login: "zeta-org", type: "Organization" }, repository_selection: "all" },
          { id: 2, account: { id: 12, login: "someone", type: "User" } },
          { id: 3, account: { id: 13, login: "alpha-org", type: "Organization" }, repository_selection: "selected" },
        ]),
      ),
    ];
    expect(await listInstalledOrgs(configured())).toEqual([
      { installationId: 3, githubOrgId: 13, login: "alpha-org", allRepositories: false },
      { installationId: 1, githubOrgId: 11, login: "zeta-org", allRepositories: true },
    ]);
  });

  it("tells whether an organization exists, through the App", async () => {
    const config = configured();
    gh.routes = [on("GET", "/orgs/heig-tin-info", () => json({ login: "heig-tin-info" }))];
    expect(await orgExistsOnGithub("heig-tin-info", config)).toBe(true);
    expect(await orgExistsOnGithub("no-such-org", config)).toBe(false);
  });

  it("reads the organization's plan with the installation, null when unreadable", async () => {
    const config = configured();
    gh.routes = [token, on("GET", "/orgs/heig-tin-info", () => json({ plan: { name: "Free" } }))];
    expect(await fetchOrgPlan(config, 42, "heig-tin-info")).toBe("free");
    gh.routes = [token, on("GET", "/orgs/heig-tin-info", () => json({ login: "heig-tin-info" }))];
    expect(await fetchOrgPlan(config, 42, "heig-tin-info")).toBeNull();
  });

  it("probes the LLM secret: ok, missing, or indeterminate", async () => {
    const config = configured();
    const secret = "/orgs/heig-tin-info/actions/secrets/ANTHROPIC_API_KEY";
    gh.routes = [token, on("GET", secret, () => json({ name: "ANTHROPIC_API_KEY" }))];
    expect(await fetchOrgLlmSecret(config, 42, "heig-tin-info")).toBe("ok");
    gh.routes = [token];
    expect(await fetchOrgLlmSecret(config, 42, "heig-tin-info")).toBe("missing");
    gh.routes = [token, on("GET", secret, () => json({ message: "Resource not accessible by integration" }, 403))];
    expect(await fetchOrgLlmSecret(config, 42, "heig-tin-info")).toBeNull();
  });
});
