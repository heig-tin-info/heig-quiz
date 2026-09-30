/**
 * A fake GitHub for the tests of the adapters and of the `github` module:
 * a real RSA key for the App's JWT, and a `fetch` stand-in that records
 * every call and answers from routes the test sets. No network is ever
 * reached: a request no route answers is GitHub's 404, and a host other
 * than GitHub's two is an error.
 *
 * Test support only; nothing in the application imports it.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A private key file the App can sign its JWT with, and its removal. */
export function appKey(): { pem: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "quiz-github-"));
  const pem = join(dir, "app.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(pem, privateKey.export({ type: "pkcs1", format: "pem" }));
  return { pem, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One answer of the fake: a response, or undefined to let the next route try. */
export type Route = (url: URL, init: RequestInit & { method: string }) => Response | undefined;

/** A route of the REST API, by method and exact path. */
export const on =
  (method: string, path: string, answer: () => Response): Route =>
  (url, init) =>
    url.host === "api.github.com" && init.method === method && url.pathname === path
      ? answer()
      : undefined;

export const AVATAR_HOST = "avatars.githubusercontent.com";

/** Every request to the avatar host, answered by `answer`. */
export const avatarRoute =
  (answer: () => Response): Route =>
  (url) =>
    url.host === AVATAR_HOST ? answer() : undefined;

/** An organization of the fake GitHub, and Quiz's App on it (or not). */
export interface FakeOrg {
  githubOrgId: number;
  login: string;
  installationId: number | null;
  selection: "all" | "selected";
  plan: string;
  secret: boolean;
  /** False: GitHub has no organization under that login any more. */
  exists: boolean;
}

/**
 * The REST routes the `github` module's adapters call, answered from a
 * world of organizations the test mutates: installation tokens, the App's
 * installations (listing and by id), an organization's installation, plan
 * and LLM secret.
 */
export function orgsRoute(orgs: () => FakeOrg[]): Route {
  const account = (o: FakeOrg) => ({ id: o.githubOrgId, login: o.login, type: "Organization" });
  const installation = (o: FakeOrg) => ({
    id: o.installationId,
    account: account(o),
    repository_selection: o.selection,
  });
  const byLogin = (login: string) =>
    orgs().find(
      (o) => o.exists && o.login.toLowerCase() === decodeURIComponent(login).toLowerCase(),
    );
  return (url, init) => {
    if (url.host !== "api.github.com") return undefined;
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (init.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return json(
        { token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        201,
      );
    }
    if (init.method !== "GET") return undefined;
    if (path === "/app/installations") {
      return json(orgs().filter((o) => o.installationId !== null).map(installation));
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(path))) {
      const o = orgs().find((x) => x.installationId === Number(m![1]));
      return o ? json(installation(o)) : undefined;
    }
    if ((m = /^\/orgs\/([^/]+)\/installation$/.exec(path))) {
      const o = byLogin(m[1]!);
      return o?.installationId ? json(installation(o)) : undefined;
    }
    if ((m = /^\/orgs\/([^/]+)\/actions\/secrets\/ANTHROPIC_API_KEY$/.exec(path))) {
      return byLogin(m[1]!)?.secret ? json({ name: "ANTHROPIC_API_KEY" }) : undefined;
    }
    if ((m = /^\/orgs\/([^/]+)$/.exec(path))) {
      const o = byLogin(m[1]!);
      return o ? json({ ...account(o), plan: { name: o.plan } }) : undefined;
    }
    return undefined;
  };
}

export interface FakeGithub {
  /** Install with `vi.stubGlobal("fetch", fake.fetch)`. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** `METHOD host/path` of every request, in order. */
  calls: string[];
  /** The `init` of every request, in the same order. */
  inits: RequestInit[];
  /** The routes answering, tried in order. */
  routes: Route[];
  /** Forgets the calls and the routes. */
  reset: () => void;
}

export function fakeGithub(): FakeGithub {
  const fake: FakeGithub = {
    calls: [],
    inits: [],
    routes: [],
    reset() {
      fake.calls.length = 0;
      fake.inits.length = 0;
      fake.routes = [];
    },
    async fetch(input, init = {}) {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const method = (init.method ?? "GET").toUpperCase();
      fake.calls.push(`${method} ${url.host}${url.pathname}`);
      fake.inits.push(init);
      if (url.host === AVATAR_HOST && init.redirect !== "error") {
        // The avatar proxy must never follow GitHub elsewhere (M2-02).
        throw new Error(`an avatar fetched without redirect: "error"`);
      }
      if (url.host !== "api.github.com" && url.host !== AVATAR_HOST) {
        throw new Error(`unexpected request to ${url.href}`);
      }
      for (const route of fake.routes) {
        const res = route(url, { ...init, method });
        if (res) return res;
      }
      return json({ message: "Not Found" }, 404);
    },
  };
  return fake;
}
