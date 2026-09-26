/**
 * ADR-027 over the real application: the `.seb` download, the launch, and
 * above all the confinement of the `seb` session, probed the way a hostile
 * HTTP client would — not the way Safe Exam Browser behaves.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import { registerForTests } from "@quiz/registry/server";

import { launchTickets } from "../db/schema.js";
import { fakeShort } from "../test/fakeType.js";
import { testServer, type TestServer } from "../test/http.js";
import { seedLive } from "../test/live.js";
import { consumeLaunchTicket, issueLaunchTicket } from "./launch.js";
import { CONFIG_KEY_HEADER, configKeyHeaderFor } from "./seb.js";
import { CSRF_COOKIE, SESSION_COOKIE } from "./session.js";

type Who = { id: string; headers: Record<string, string> };
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The routes that declare `SITTING` (ADR-027), and no others. */
const SITTING_ROUTES = new Set([
  "GET /app/api/me",
  "GET /app/api/events",
  "POST /app/api/evaluations/:id/attempt",
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

/** Every (method, path) of `printRoutes`' tree, HEAD aside. */
function routesOf(tree: string): { method: Method; path: string }[] {
  const stack: string[] = [];
  return tree.split("\n").flatMap((line) => {
    const match = /^(.*?)[├└]── (\S+) \(([^)]+)\)/.exec(line);
    if (!match) return [];
    const depth = match[1]!.length / 4;
    stack.length = depth;
    stack.push(match[2]!);
    const path = stack.join("");
    return match[3]!
      .split(", ")
      .filter((m) => m !== "HEAD")
      .map((method) => ({ method: method as Method, path }));
  });
}

let server: TestServer;
let restore: () => void;
let teacher: Who;
let student: Who;
let exam: Awaited<ReturnType<typeof seedLive>>;
let other: Awaited<ReturnType<typeof seedLive>>;

const call = (
  method: Method,
  url: string,
  headers: Record<string, string>,
  payload: object = {},
) => server.app.inject({ method, url, headers, ...(method === "GET" ? {} : { payload }) });

/** Downloads a `.seb` and returns the start URL written in it. */
async function download(evaluationId: string, who: Who = student): Promise<string> {
  const res = await call("GET", `/app/api/evaluations/${evaluationId}/seb`, who.headers);
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("application/seb");
  return /<key>startURL<\/key>\s*<string>([^<]+)<\/string>/.exec(res.body)![1]!;
}

/** Opens the start URL as SEB would (or without its header), and returns the response. */
const launch = (startUrl: string, header = configKeyHeaderFor(startUrl)) =>
  server.app.inject({ method: "GET", url: new URL(startUrl).pathname, headers: { [CONFIG_KEY_HEADER]: header } });

/** The session headers a successful launch set. */
function sessionOf(res: Awaited<ReturnType<typeof launch>>): Record<string, string> {
  const jar = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
  return {
    cookie: `${SESSION_COOKIE}=${jar[SESSION_COOKIE]}; ${CSRF_COOKIE}=${jar[CSRF_COOKIE]}`,
    "x-csrf-token": jar[CSRF_COOKIE]!,
  };
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  const seed = (settings: object) =>
    seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], mode: "exam", settings });
  exam = await seed({ safeExamBrowser: true });
  other = await seed({ safeExamBrowser: true });
  for (const e of [exam, other]) {
    const started = await call("POST", `/app/api/evaluations/${e.evaluationId}/start`, teacher.headers, {
      confirm: true,
    });
    expect(started.statusCode, started.body).toBe(200);
  }
});
afterAll(async () => {
  await server.close();
  restore();
});

describe("the launch ticket", () => {
  it("is stored as a hash, and a new file revokes the previous one", async () => {
    const first = await download(exam.evaluationId);
    const second = await download(exam.evaluationId);
    const rows = await server.app.db
      .select()
      .from(launchTickets)
      .where(eq(launchTickets.evaluationId, exam.evaluationId));
    expect(JSON.stringify(rows)).not.toContain(first.split("/").pop());
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    expect((await launch(first)).headers.location).toBe("/?seb=invalid");
    expect((await launch(second)).headers.location).toBe(`/take/${exam.evaluationId}`);
  });

  it("is consumed exactly once, even by two requests at the same instant", async () => {
    const now = server.clock.now();
    const secret = await issueLaunchTicket(
      server.app.db,
      { kind: "seb", userId: student.id, actorUserId: student.id, evaluationId: exam.evaluationId },
      now,
    );
    const both = await Promise.all([
      consumeLaunchTicket(server.app.db, secret, now),
      consumeLaunchTicket(server.app.db, secret, now),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it("is left untouched by a browser that is not SEB, and refused a second time", async () => {
    const url = await download(exam.evaluationId);
    expect((await launch(url, "not-seb")).headers.location).toBe("/?seb=invalid");
    expect((await launch(url)).headers.location).toBe(`/take/${exam.evaluationId}`);
    expect((await launch(url)).headers.location).toBe("/?seb=invalid");
  });

  it("is only issued to a seated student, on an exam that requires SEB", async () => {
    const stranger = await server.signIn("student");
    expect((await call("GET", `/app/api/evaluations/${exam.evaluationId}/seb`, stranger.headers)).statusCode).toBe(404);
    const plain = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id] });
    expect((await call("GET", `/app/api/evaluations/${plain.evaluationId}/seb`, student.headers)).statusCode).toBe(404);
    // The switch is an exam's: on an exercise it is inert, and the exercise is sat from the portal.
    const exercise = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [student.id],
      mode: "exercise",
      settings: { safeExamBrowser: true },
    });
    expect((await call("GET", `/app/api/evaluations/${exercise.evaluationId}/seb`, student.headers)).statusCode).toBe(404);
  });
});

describe("the seb session (ADR-027)", () => {
  let seb: Record<string, string>;
  let attemptId: string;
  let otherAttemptId: string;

  beforeAll(async () => {
    seb = sessionOf(await launch(await download(exam.evaluationId)));
    // An attempt of the OTHER evaluation, entered through its own launch.
    const otherSeb = sessionOf(await launch(await download(other.evaluationId)));
    otherAttemptId = (await call("POST", `/app/api/evaluations/${other.evaluationId}/attempt`, otherSeb)).json().view.attempt.id;
  });

  it("sits its own evaluation", async () => {
    const me = await call("GET", "/app/api/me", seb);
    expect(me.json().session).toEqual({ kind: "seb", evaluationId: exam.evaluationId });
    const entered = await call("POST", `/app/api/evaluations/${exam.evaluationId}/attempt`, seb);
    expect(entered.statusCode).toBe(200);
    attemptId = entered.json().view.attempt.id;
    expect((await call("GET", `/app/api/attempts/${attemptId}`, seb)).statusCode).toBe(200);
    // (A stream that opens never ends under `inject`: only the refusals below are probed.)
  });

  it("reaches no other evaluation, even by the id of its attempt", async () => {
    expect((await call("POST", `/app/api/evaluations/${other.evaluationId}/attempt`, seb)).statusCode).toBe(404);
    expect((await call("GET", `/app/api/attempts/${otherAttemptId}`, seb)).statusCode).toBe(404);
    expect((await call("GET", `/app/api/events?watch=lobby:${other.evaluationId}`, seb)).statusCode).toBe(404);
    expect((await call("GET", "/app/api/events", seb)).statusCode).toBe(404);
  });

  it("is no session at all on every route that does not declare it", async () => {
    // Every route of the application, from Fastify's own tree, is asked twice:
    // with the `seb` session and with none. Outside the routes that declare
    // `SITTING`, the two answers must be the same — a route that opens up to
    // `seb` without being listed here fails this test.
    const anonymous = { "x-csrf-token": seb["x-csrf-token"]! };
    for (const { method, path } of routesOf(server.app.printRoutes({ commonPrefix: false }))) {
      // The OIDC round trip reaches for the identity provider; neither serves `seb`.
      if (SITTING_ROUTES.has(`${method} ${path}`) || /^\/app\/auth\/(login|callback)$/.test(path)) continue;
      const url = path.replace(/:\w+/g, "00000000-0000-4000-8000-000000000000").replace("*", "x");
      const [asSeb, asNobody] = await Promise.all([call(method, url, seb), call(method, url, anonymous)]);
      expect(asSeb.statusCode, `${method} ${path}`).toBe(asNobody.statusCode);
    }
  });

  it("is the only way in: a portal session cannot sit an evaluation that requires SEB", async () => {
    expect((await call("POST", `/app/api/evaluations/${exam.evaluationId}/attempt`, student.headers)).statusCode).toBe(404);
    expect((await call("GET", `/app/api/attempts/${attemptId}`, student.headers)).statusCode).toBe(404);
    expect((await call("GET", `/app/api/events?watch=attempt:${attemptId}`, student.headers)).statusCode).toBe(404);
  });
});
