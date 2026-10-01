/**
 * The route walks of `seb.db.test.ts` and `impersonation.db.test.ts`, on a
 * server built WITH Quiz's App: the `github` and `journal` modules' routes
 * exist only then, so the walks of those files, run without an App, never
 * see them.
 *
 * - a `seb` session is no session at all on every route of the module
 *   (ADR-027): it answers exactly as an anonymous request;
 * - an impersonation session writes nothing (ADR-034), and reads no
 *   classroom's GitHub link, not even its student's classroom (invariant 6);
 * - the webhook intake serves no session at all (`sessions: []`): a signed
 *   delivery needs none, and a session sent along changes nothing.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import {
  everyRoute,
  issueImpersonation,
  openImpersonation,
  openSebSession,
  SITTING_ROUTES,
  walkUrl,
} from "../../auth/testing.js";
import { enrollments } from "../../db/schema.js";
import { appKey, fakeGithub, signedDelivery } from "../../github/testing.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Method, type TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";

const key = appKey();
const gh = fakeGithub();
let restore: () => void;
let server: TestServer;
let seed: Seeded;
let student: { id: string; headers: Record<string, string> };

const SECRET = "h".repeat(40);
const WEBHOOK = "/webhooks/github";

/** A delivery GitHub signed, with a session's `headers` sent along. */
const delivery = (headers: Record<string, string> = {}) =>
  signedDelivery(server.app, SECRET, { zen: "Anything added dilutes everything else." }, { headers });

const call = (method: Method, url: string, headers: Record<string, string>, payload: object = {}) =>
  server.app.inject({ method, url, headers, ...(method === "GET" ? {} : { payload }) });

/** The routes the App adds: the `github` module's and the journal's (M4-02). */
const githubRoutes = () =>
  everyRoute(server).filter(({ path }) => path.includes("github") || path.includes("/journal"));

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer({
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
    GITHUB_APP_SLUG: "quiz-test",
    GITHUB_WEBHOOK_SECRET: SECRET,
    SEB_CONFIG_KEY_ENFORCE: "1",
  });
  server.clock.set("2026-09-21T08:00:00.000Z");
  const teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    mode: "exam",
    settings: { safeExamBrowser: true },
  });
  const started = await call("POST", `/app/api/evaluations/${seed.evaluationId}/start`, teacher.headers, {
    confirm: true,
  });
  expect(started.statusCode, started.body).toBe(200);
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
  restore();
});

it("walks the github module's and the journal's routes (the App is on)", () => {
  expect(githubRoutes().length).toBeGreaterThanOrEqual(6);
  // Fastify's tree prints the journal's wildcard routes (pages, assets) as
  // `pages*` and `journal*`, which these walks reach as no route at all:
  // `journal.db.test.ts` walks the reads by hand, `writes.db.test.ts` the writes.
  const walked = new Set(githubRoutes().map(({ method, path }) => `${method} ${path}`));
  for (const write of ["POST", "DELETE", "POST /use", "POST /refresh", "POST /preview", "POST /pages"]) {
    const [method, tail = ""] = write.split(" ");
    expect(walked, write).toContain(`${method} /app/api/classrooms/:id/journal${tail}`);
  }
});

describe("a seb session (ADR-027)", () => {
  it("is no session at all on every route of the module", async () => {
    const seb = await openSebSession(server, seed.evaluationId, student.headers);
    for (const { method, path } of githubRoutes()) {
      if (SITTING_ROUTES.has(`${method} ${path}`)) continue;
      const url = walkUrl(path);
      const { cookie: _, ...anonymous } = seb(url);
      const [asSeb, asNobody] = await Promise.all([
        call(method, url, seb(url)),
        call(method, url, anonymous),
      ]);
      expect(asSeb.statusCode, `${method} ${path}`).toBe(asNobody.statusCode);
    }
  });

  it("changes nothing to a signed webhook delivery", async () => {
    const seb = await openSebSession(server, seed.evaluationId, student.headers);
    expect((await delivery(seb(WEBHOOK))).statusCode).toBe(200);
  });
});

describe("the webhook intake", () => {
  it("needs no session at all", async () => {
    expect((await delivery()).statusCode).toBe(200);
  });
});

describe("an impersonation session (ADR-034)", () => {
  let as: Record<string, string>;

  beforeAll(async () => {
    const admin = await server.signInWithSuperPowers();
    const [entry] = await server.app.db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(eq(enrollments.userId, student.id));
    const path = await issueImpersonation(server, admin.headers, seed.classroomId, entry!.id);
    as = (await openImpersonation(server, path as string))!;
  });

  it("writes nothing, on every route of the module", async () => {
    for (const { method, path } of githubRoutes()) {
      // The intake serves no session: an impersonation's is not there at all (below).
      if (method === "GET" || path === WEBHOOK) continue;
      const res = await call(method, walkUrl(path), as);
      expect(res.statusCode, `${method} ${path}`).toBe(403);
      expect(res.json().error, `${method} ${path}`).toBe("impersonation_read_only");
    }
  });

  it("is no session at all on the webhook intake", async () => {
    const unsigned = (headers: Record<string, string> = {}) =>
      signedDelivery(server.app, SECRET, {}, { signature: null, headers });
    const [asImpersonation, asNobody] = await Promise.all([unsigned(as), unsigned()]);
    expect(asImpersonation.statusCode).toBe(401);
    expect(asNobody.statusCode).toBe(401);
    expect((await delivery(as)).statusCode).toBe(200);
  });

  it("reads no GitHub link, not even of the student's own classroom", async () => {
    const res = await call("GET", `/app/api/classrooms/${seed.classroomId}/github`, as);
    expect(res.statusCode).toBe(404);
  });
});
