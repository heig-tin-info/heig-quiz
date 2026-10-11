/**
 * Proxy refusals, mounted on a real portal (Fastify, database, plugins) with a
 * fake engine.
 *
 * Only the **refusal** paths are tested here: they never reach the upstream, so
 * the test does not need a code-server. The nominal path — workspace served,
 * websocket established — is checked for real by an end-to-end run (heig-classroom's `scripts/e2e.ts`, not imported: M6-04), with a
 * container.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../auth/config.js";
import { openDb, type DbHandle } from "../db/client.js";
import { assignments, sessions, users } from "../db/schema.js";
import type { ContainerInfo, Engine } from "../engine/index.js";
import { EXAM_COOKIE, issueExamCookie } from "../seb/index.js";
import { buildPortal, type Portal } from "../server.js";

import {
  REMOTE_RESOURCE_HEADERS,
  SESSION_COOKIE,
  cookieValue,
  isEntryRequest,
  isPortProxyRequest,
  isRemoteResourceRequest,
  parseCookieValue,
  upstreamHeaders,
} from "./index.js";

const EXAM_SECRET = "a-test-secret-long-enough-2";
const TOKEN = "test-session-token";

const fakeEngine: Engine = {
  runArgs: () => [],
  containerName: (sessionId) => `cs-test-${sessionId}`,
  run: async (req) => ({
    id: "ctr",
    name: req.name,
    sessionId: req.sessionId,
    state: "running",
    ip: "10.77.0.9",
  }),
  inspect: async (name): Promise<ContainerInfo | null> => ({
    id: "ctr",
    name,
    sessionId: "s1",
    state: "running",
    ip: "10.77.0.9",
  }),
  stop: async () => undefined,
  rm: async () => undefined,
  listSessions: async () => [],
  waitHealthy: async () => 1,
  exec: async () => "",
};

let handle: DbHandle;
let portal: Portal;
let config: AppConfig;

beforeEach(async () => {
  handle = openDb(":memory:");
  config = loadConfig({
    EXAM_COOKIE_SECRET: EXAM_SECRET,
    SEB_VERIFIER: "simulated",
    TRUST_PROXY: "1",
    LOG_LEVEL: "fatal",
  });
  const now = new Date();
  handle.db
    .insert(users)
    .values({
      id: "u1",
      oidcSub: "sub-1",
      login: "student",
      email: "s@heig-vd.ch",
      displayName: "Sacha",
      role: "student",
      createdAt: now,
    })
    .run();
  for (const [id, mode] of [
    ["tp", "lab"],
    ["ex", "exam"],
  ] as const) {
    handle.db
      .insert(assignments)
      .values({
        id,
        title: id,
        mode,
        image: "codespace/c-dev:4.137.0",
        uploadPack: true,
        beks: ["0".repeat(64)],
        createdAt: now,
      })
      .run();
  }
  for (const [id, assignmentId] of [
    ["s1", "tp"],
    ["s2", "ex"],
  ] as const) {
    handle.db
      .insert(sessions)
      .values({
        id,
        userId: "u1",
        student: "student",
        assignmentId,
        containerId: "ctr",
        containerName: `cs-${id}`,
        containerIp: "10.77.0.9",
        volumeDir: `/tmp/vol/${id}`,
        state: "running",
        createdAt: now,
        lastSeen: now,
        cookieToken: TOKEN,
        sebVerified: assignmentId === "ex",
      })
      .run();
  }
  portal = await buildPortal({
    config,
    dbHandle: handle,
    engine: fakeEngine,
    withGitServer: false,
    withTimers: false,
  });
});

afterEach(async () => {
  await portal.close();
});

describe("codespace session cookie value", () => {
  it("is read back", () => {
    expect(parseCookieValue(cookieValue("s1", TOKEN))).toEqual({
      sessionId: "s1",
      token: TOKEN,
    });
  });
  it("rejects a value without a separator", () => {
    expect(parseCookieValue("s1")).toBeNull();
    expect(parseCookieValue(undefined)).toBeNull();
    expect(parseCookieValue(".token")).toBeNull();
  });
});

describe("entry request", () => {
  it("recognizes the page reload and only it", () => {
    expect(isEntryRequest("/s/s1/", "s1")).toBe(true);
    expect(isEntryRequest("/s/s1", "s1")).toBe(true);
    expect(isEntryRequest("/s/s1/?folder=/work", "s1")).toBe(true);
    expect(isEntryRequest("/s/s1/static/out/vs/workbench.js", "s1")).toBe(false);
  });
});

describe("one origin for every session (audit L24)", () => {
  it.each([
    "/s/s1/proxy/8080/",
    "/s/s1/proxy/8080",
    "/s/s1/absproxy/5000/index.html?x=1",
    "/s/s1/PROXY/8080/",
    "/s/s1//proxy/8080/",
    "/s/s1/%70roxy/8080/",
    "/s/s1/./proxy/8080/",
    "/s/s1/x/../proxy/8080/",
    "/s/s1/x/%2e%2e/absproxy/8080/",
    "/s/s1/proxy%2F8080/",
  ])("%s is code-server's port proxy", (url) => {
    expect(isPortProxyRequest(url)).toBe(true);
  });

  it.each([
    "/s/s1/",
    "/s/s1/?folder=/work",
    "/s/s1/static/out/proxy.js",
    "/s/s1/stable-abc/vscode-remote-resource?path=/proxy/1/",
    "/s/s1/proxyfoo/8080/",
    "/s/s1/healthz",
  ])("%s is not", (url) => {
    expect(isPortProxyRequest(url)).toBe(false);
  });

  it("recognizes the remote resource route, with or without the commit prefix", () => {
    expect(isRemoteResourceRequest("/s/s1/vscode-remote-resource?path=/work/x.html")).toBe(true);
    expect(isRemoteResourceRequest("/s/s1/stable-b11d/vscode-remote-resource?path=/x&tkn=")).toBe(true);
    expect(isRemoteResourceRequest("/s/s1/vscode/VSCODE-REMOTE-RESOURCE?path=/x")).toBe(true);
    expect(isRemoteResourceRequest("/s/s1/stable-b11d/static/out/vs/workbench.js")).toBe(false);
    expect(isRemoteResourceRequest("/s/s1/?path=/vscode-remote-resource")).toBe(false);
  });

  it("drops Set-Cookie and Service-Worker-Allowed from every answer", () => {
    const out = upstreamHeaders(
      {
        "content-type": "text/javascript",
        "set-cookie": ["vscode-tkn=x; SameSite=Lax", "a=b; Path=/"],
        "service-worker-allowed": "/",
        etag: '"1"',
      },
      "s1",
      "/s/s1/_static/out/browser/serviceWorker.js",
    );
    expect(out).toEqual({ "content-type": "text/javascript", etag: '"1"' });
  });

  it("still rewrites an absolute Location into the session, and only that", () => {
    expect(upstreamHeaders({ location: "/login" }, "s1", "/s/s1/x").location).toBe("/s/s1/login");
    expect(upstreamHeaders({ location: "./?folder=/work" }, "s1", "/s/s1/").location).toBe("./?folder=/work");
    expect(upstreamHeaders({ location: "//evil.example/" }, "s1", "/s/s1/").location).toBe("//evil.example/");
  });

  it("serves a remote resource sandboxed and unsniffed, whatever code-server sent", () => {
    const out = upstreamHeaders(
      { "content-type": "text/html", "content-security-policy": "default-src *" },
      "s1",
      "/s/s1/stable-b11d/vscode-remote-resource?path=/work/x.html",
    );
    expect(out).toEqual({ "content-type": "text/html", ...REMOTE_RESOURCE_HEADERS });
    expect(out["content-security-policy"]).toBe("default-src 'none'; sandbox");
    // Any other route keeps its own policy: the workbench page needs its scripts.
    const page = upstreamHeaders({ "content-security-policy": "script-src 'self'" }, "s1", "/s/s1/?folder=/work");
    expect(page["content-security-policy"]).toBe("script-src 'self'");
  });

  it.each(["/s/s1/proxy/8080/", "/s/s1/absproxy/8080/x", "/s/s1/%70roxy/8080/"])(
    "the portal refuses %s with a 403 before any upstream",
    async (url) => {
      const res = await portal.app.inject({
        method: "GET",
        url,
        cookies: { [SESSION_COOKIE]: cookieValue("s1", TOKEN) },
        headers: { "accept-language": "en" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("Port forwarding unavailable");
    },
  );

  it("refuses the port proxy without a cookie as any other request: the session's 403", async () => {
    const res = await portal.app.inject({ method: "GET", url: "/s/s1/proxy/8080/" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Session non autorisée");
  });
});

describe("proxy refusals", () => {
  it("403 without a session cookie", async () => {
    const res = await portal.app.inject({ method: "GET", url: "/s/s1/" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Session non autorisée");
  });

  it("403 with a cookie from another session", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s1/",
      cookies: { [SESSION_COOKIE]: cookieValue("s2", TOKEN) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403 with a wrong token for the right session", async () => {
    // This is also the shape of the audit L3 case: since the token is rotated
    // at every opening, resumption and close of the session
    // (`sessions/manager.ts`), a cookie copied earlier — an older tab in
    // another browser, a stolen value — arrives here with a token that is no
    // longer the row's, and gets this page.
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s1/",
      cookies: { [SESSION_COOKIE]: cookieValue("s1", "wrong-token") },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Session non autorisée");
  });

  it("404 for an unknown session", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/unknown/",
      cookies: { [SESSION_COOKIE]: cookieValue("unknown", TOKEN) },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("exam mode — invariant 5: the proxy reads no SEB header", () => {
  const examCookie = (address: string, sessionId = "s2"): string =>
    issueExamCookie(
      { assignmentId: "ex", sessionId, clientAddress: address, issuedAt: Date.now() },
      { secret: EXAM_SECRET },
    );

  it("refuses even with the SEB headers, if there is no exam cookie", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s2/",
      cookies: { [SESSION_COOKIE]: cookieValue("s2", TOKEN) },
      headers: {
        "x-dev-seb": "ok",
        "x-safeexambrowser-configkeyhash": "0".repeat(64),
        "x-safeexambrowser-requesthash": "0".repeat(64),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Safe Exam Browser");
  });

  it("refuses an exam cookie issued for another address (analyse.md D5)", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s2/",
      remoteAddress: "192.0.2.4",
      cookies: {
        [SESSION_COOKIE]: cookieValue("s2", TOKEN),
        [EXAM_COOKIE]: examCookie("192.0.2.1"),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("autre poste");
  });

  it("refuses an exam cookie issued for another session", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/s/s2/",
      remoteAddress: "192.0.2.1",
      cookies: {
        [SESSION_COOKIE]: cookieValue("s2", TOKEN),
        [EXAM_COOKIE]: examCookie("192.0.2.1", "s1"),
      },
    });
    expect(res.statusCode).toBe(403);
  });
});


describe("no login of its own (M6-03)", () => {
  it("/ is a landing page that opens nothing", async () => {
    const res = await portal.app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<form");
  });

  it.each([
    ["GET", "/auth/login"],
    ["GET", "/auth/callback"],
    ["GET", "/teacher/sessions"],
    ["POST", "/teacher/sessions/s1/close"],
    ["POST", "/assignments/tp/start"],
  ] as const)("%s %s does not exist", async (method, url) => {
    const res = await portal.app.inject({ method, url });
    expect(res.statusCode).toBe(404);
  });

  it("/exam/<id>/start does not exist, even with an SEB header: an exam opens through /launch", async () => {
    const res = await portal.app.inject({
      method: "GET",
      url: "/exam/ex/start",
      headers: { accept: "text/html", "x-dev-seb": "ok" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.cookies.find((c) => c.name === EXAM_COOKIE)).toBeUndefined();
  });

  it("serves no `.seb` of its own: the platform builds them (D21, M6-07)", async () => {
    for (const url of ["/exam/ex.seb", "/exam/tp.seb"]) {
      expect((await portal.app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });
});
