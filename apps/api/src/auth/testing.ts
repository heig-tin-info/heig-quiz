/**
 * The confined and delegated sessions of the route walks (ADR-027,
 * ADR-051, ADR-034), opened the way a browser opens them: a `seb` session
 * through its `.seb` file and SEB's launch, an impersonation through an
 * admin's one-time link. Shared by `seb.db.test.ts`,
 * `impersonation.db.test.ts` and the walks of a module whose routes exist
 * only under some configuration (`modules/github/walks.db.test.ts`).
 *
 * Test support only; nothing in the application imports it.
 */
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";

import { CONFIG_KEY_HEADER, absoluteRequestUrl, expectedHash } from "@quiz/seb";

import { routesOf, type Method, type TestServer } from "../test/http.js";
import { configKeyHeaderFor, launchConfigKey } from "./seb.js";
import { CSRF_COOKIE, SESSION_COOKIE } from "./session.js";

/** The routes that declare `SITTING` (ADR-027), and no others. */
export const SITTING_ROUTES = new Set([
  "GET /app/api/me",
  "GET /app/api/events",
  "POST /app/api/evaluations/:id/attempt",
  "POST /app/api/evaluations/:id/attempt/start",
  "GET /app/api/attempts/:id",
  "PUT /app/api/attempts/:id/answers/:itemId",
  "POST /app/api/attempts/:id/answers/:itemId/done",
  "POST /app/api/attempts/:id/answers/:itemId/skip",
  "POST /app/api/attempts/:id/answers/:itemId/flag",
  "POST /app/api/attempts/:id/position",
  "POST /app/api/attempts/:id/submit",
  "POST /app/api/attempts/:id/events",
  "POST /app/api/attempts/:id/run",
  "POST /app/api/attempts/:id/simulate",
]);

/** A route's path with its parameters filled by a well-formed id nobody holds. */
export const walkUrl = (path: string) =>
  path.replace(/:\w+/g, "00000000-0000-4000-8000-000000000000").replace("*", "x");

/** Every (method, path) of the application, from Fastify's own tree. */
export const everyRoute = (server: TestServer): { method: Method; path: string }[] =>
  routesOf(server.app.printRoutes({ commonPrefix: false }));

/** The session cookies a response set, and its CSRF header. */
export function sessionCookies(res: LightMyRequestResponse): Record<string, string> {
  const jar = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
  return {
    cookie: `${SESSION_COOKIE}=${jar[SESSION_COOKIE]}; ${CSRF_COOKIE}=${jar[CSRF_COOKIE]}`,
    "x-csrf-token": jar[CSRF_COOKIE]!,
  };
}

// ---------------------------------------------------------------- seb (ADR-027, ADR-051)

/** Downloads a `.seb` as `headers` and returns the start URL written in it. */
export async function sebStartUrl(
  server: TestServer,
  evaluationId: string,
  headers: Record<string, string>,
): Promise<string> {
  const res = await server.app.inject({
    method: "GET",
    url: `/app/api/evaluations/${evaluationId}/seb`,
    headers,
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("application/seb");
  return /<key>startURL<\/key>\s*<string>([^<]+)<\/string>/.exec(res.body)![1]!;
}

/** Opens the start URL as SEB would (or without its header), and returns the response. */
export const launchSeb = (
  server: TestServer,
  startUrl: string,
  header = configKeyHeaderFor(startUrl),
) =>
  server.app.inject({
    method: "GET",
    url: new URL(startUrl).pathname,
    headers: { [CONFIG_KEY_HEADER]: header },
  });

/**
 * The headers SEB sends on every request of the session a launch opened: its
 * cookies, and the Config Key hash of that very URL (ADR-051 §3).
 */
export function sebSessionOf(
  res: LightMyRequestResponse,
  startUrl: string,
): (url: string) => Record<string, string> {
  const cookies = sessionCookies(res);
  const key = launchConfigKey(startUrl);
  return (url) => ({ ...cookies, [CONFIG_KEY_HEADER]: expectedHash(absoluteRequestUrl(startUrl, url), key) });
}

/** Downloads a `.seb` as the seated student and opens it as SEB would. */
export async function openSebSession(
  server: TestServer,
  evaluationId: string,
  student: Record<string, string>,
): Promise<(url: string) => Record<string, string>> {
  const startUrl = await sebStartUrl(server, evaluationId, student);
  return sebSessionOf(await launchSeb(server, startUrl), startUrl);
}

// ---------------------------------------------------------------- impersonation (ADR-034)

/** Asks for a link to act as a roster entry's student; its path, or the status code. */
export async function issueImpersonation(
  server: TestServer,
  headers: Record<string, string>,
  classroomId: string,
  entryId: string,
): Promise<string | number> {
  const res = await server.app.inject({
    method: "POST",
    url: `/app/api/classrooms/${classroomId}/roster/${entryId}/impersonation`,
    headers,
    payload: {},
  });
  return res.statusCode === 200 ? new URL(res.json().url as string).pathname : res.statusCode;
}

/** Opens a link in a browser with no session; the session headers, or null. */
export async function openImpersonation(
  server: TestServer,
  path: string,
): Promise<Record<string, string> | null> {
  const res = await server.app.inject({ method: "GET", url: path });
  expect(res.statusCode).toBe(303);
  if (res.headers.location !== "/") {
    expect(res.headers.location).toBe("/?impersonation=invalid");
    return null;
  }
  return sessionCookies(res);
}
