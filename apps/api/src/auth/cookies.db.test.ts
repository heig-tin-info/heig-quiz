/**
 * The names and flags of the first-party cookies (audit L8): `__Host-`
 * prefixed wherever they are `Secure` (production, staging), bare in
 * development over plain http; a session cookie without its CSRF cookie
 * refused; the bare names of before the prefix never read, and expired.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CSRF_COOKIE } from "@quiz/contracts";

import { sessions } from "../db/schema.js";
import { KIOSK_COOKIE } from "../modules/kiosk/service.js";
import { testServer, type TestServer } from "../test/http.js";
import { SESSION_COOKIE, hashToken } from "./session.js";

type Res = { headers: Record<string, unknown> };

/** The `Set-Cookie` lines of a response, by cookie name. */
function setCookies(res: Res): Record<string, string> {
  const lines = [res.headers["set-cookie"]].flat().filter((c): c is string => typeof c === "string");
  return Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf("=")), line]));
}

/** A cookie header's value for `name`. */
const valueOf = (cookie: string, name: string) =>
  cookie
    .split("; ")
    .find((pair) => pair.startsWith(`${name}=`))!
    .slice(name.length + 1);

const expired = (line: string | undefined) => /Expires=Thu, 01 Jan 1970/i.test(line ?? "") || /Max-Age=0/i.test(line ?? "");

describe.each([
  { mode: "production", production: true, session: "__Host-quiz_session", csrf: "__Host-quiz_csrf" },
  { mode: "development", production: false, session: "quiz_session", csrf: "quiz_csrf" },
])("the session cookies in $mode", ({ production, session, csrf }) => {
  let server: TestServer;

  beforeAll(async () => {
    server = await testServer({ KIOSK_ATTESTATION: "mock" }, { production });
  });

  afterAll(async () => {
    await server.close();
  });

  const me = (headers: Record<string, string>, method: "GET" | "PATCH" = "GET") =>
    server.app.inject({
      method,
      url: "/app/api/me",
      headers,
      ...(method === "PATCH" ? { payload: { locale: "fr" } } : {}),
    });

  it(`are named ${session} and ${csrf}`, async () => {
    expect(server.app.cookieName(SESSION_COOKIE)).toBe(session);
    expect(server.app.cookieName(CSRF_COOKIE)).toBe(csrf);
    const { headers } = await server.signIn("student");
    expect((await me(headers)).statusCode).toBe(200);
    expect((await me(headers, "PATCH")).statusCode).toBe(200);
  });

  it("are set on Path=/, without a Domain, Secure exactly in production", async () => {
    const { headers } = await server.signIn("student");
    // Less than half the TTL left: the next request renews, and re-sets both.
    const token = valueOf(headers.cookie!, session);
    await server.app.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(sessions.sidHash, hashToken(token)));
    const set = setCookies(await me(headers));
    for (const [name, httpOnly] of [[session, true], [csrf, false]] as const) {
      const line = set[name]!;
      expect(line).toMatch(/; Path=\/(;|$)/);
      expect(line).not.toMatch(/Domain=/i);
      expect(line).toMatch(/SameSite=Lax/);
      expect(/; Secure/.test(line)).toBe(production);
      expect(/; HttpOnly/.test(line)).toBe(httpOnly);
    }
  });

  it("refuse a write that carries the session cookie without its CSRF cookie", async () => {
    const { headers } = await server.signIn("student");
    const token = valueOf(headers.cookie!, session);
    const sessionOnly = { cookie: `${session}=${token}`, "x-csrf-token": headers["x-csrf-token"]! };
    const res = await me(sessionOnly, "PATCH");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf" });
  });

  it("refuse a public POST that carries the session cookie without its CSRF cookie, and let a cookieless browser through", async () => {
    const { headers } = await server.signIn("student");
    const token = valueOf(headers.cookie!, session);
    const join = (h: Record<string, string>) =>
      server.app.inject({ method: "POST", url: "/app/api/p/ZZZZZZ/join", headers: h });
    expect((await join({ cookie: `${session}=${token}` })).statusCode).toBe(403);
    // No session, no CSRF cookie: nothing to steal, the poll answers (no such poll).
    expect((await join({})).statusCode).toBe(404);
    // The pair, with its header.
    expect((await join(headers)).statusCode).toBe(404);
  });

  it("clear both on sign-out, by their names", async () => {
    const { headers } = await server.signIn("student");
    const res = await server.app.inject({ method: "POST", url: "/app/auth/logout", headers });
    expect(res.statusCode).toBe(204);
    const set = setCookies(res);
    // A browser drops a `__Host-` deletion that is not Secure on Path=/ itself.
    for (const name of [session, csrf]) {
      expect(expired(set[name])).toBe(true);
      expect(set[name]).toMatch(/; Path=\/(;|$)/);
      expect(/; Secure/.test(set[name]!)).toBe(production);
    }
  });

  it("leave the kiosk station's cookie bare and scoped to /app/api (ADR-089)", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/app/api/kiosk/attest/verify",
      payload: { response: `mock:station-${production ? "prod" : "dev"}` },
    });
    expect(res.statusCode).toBe(200);
    const line = setCookies(res)[KIOSK_COOKIE]!;
    expect(line).toMatch(/; Path=\/app\/api(;|$)/);
    expect(line).toMatch(/SameSite=Strict/);
    expect(/; Secure/.test(line)).toBe(production);
  });
});

describe("the bare names of before the prefix, in production", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await testServer({}, { production: true });
  });

  afterAll(async () => {
    await server.close();
  });

  it("are never read as a session, and are expired on the first request that shows them", async () => {
    const { headers } = await server.signIn("teacher");
    const token = valueOf(headers.cookie!, "__Host-quiz_session");
    const csrf = headers["x-csrf-token"]!;
    const legacy = { cookie: `quiz_session=${token}; quiz_csrf=${csrf}`, "x-csrf-token": csrf };

    const read = await server.app.inject({ method: "GET", url: "/app/api/me", headers: legacy });
    expect(read.statusCode).toBe(401);
    const set = setCookies(read);
    expect(expired(set.quiz_session)).toBe(true);
    expect(expired(set.quiz_csrf)).toBe(true);
    expect(set.quiz_session).toMatch(/; Path=\/(;|$)/);

    const write = await server.app.inject({ method: "PATCH", url: "/app/api/me", headers: legacy, payload: { locale: "fr" } });
    expect(write.statusCode).toBe(401);
  });

  it("let the prefixed pair through beside them, and still expire them", async () => {
    const { headers } = await server.signIn("teacher");
    const res = await server.app.inject({
      method: "GET",
      url: "/app/api/me",
      headers: { ...headers, cookie: `quiz_session=stale; ${headers.cookie}` },
    });
    expect(res.statusCode).toBe(200);
    expect(expired(setCookies(res).quiz_session)).toBe(true);
    expect(setCookies(res).quiz_csrf).toBeUndefined();
  });
});
