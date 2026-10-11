/**
 * The names and flags of the first-party cookies (audit L8): `__Host-`
 * prefixed wherever they are `Secure` (production, staging), bare in
 * development over plain http; a session cookie without its CSRF cookie
 * refused; the bare names of before the prefix never read.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sessions } from "../db/schema.js";
import { KIOSK_COOKIE } from "../modules/kiosk/service.js";
import { testServer, type TestServer } from "../test/http.js";
import { hashToken } from "./session.js";

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

  it(`are ${session} and ${csrf}, on Path=/, without a Domain, Secure exactly in production`, async () => {
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

  it.runIf(production)("are never read under the bare names of before the prefix", async () => {
    const { headers } = await server.signIn("teacher");
    const token = valueOf(headers.cookie!, session);
    const csrfToken = headers["x-csrf-token"]!;
    const bare = { cookie: `quiz_session=${token}; quiz_csrf=${csrfToken}`, "x-csrf-token": csrfToken };
    expect((await me(bare)).statusCode).toBe(401);
  });

  it("leave the kiosk station's cookie bare, Secure exactly in production (ADR-089)", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/app/api/kiosk/attest/verify",
      payload: { response: `mock:station-${production ? "prod" : "dev"}` },
    });
    expect(res.statusCode).toBe(200);
    expect(/; Secure/.test(setCookies(res)[KIOSK_COOKIE]!)).toBe(production);
  });
});
