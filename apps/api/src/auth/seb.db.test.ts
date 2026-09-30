/**
 * ADR-027 over the real application: the `.seb` download, the launch, and
 * above all the confinement of the `seb` session, probed the way a hostile
 * HTTP client would — not the way Safe Exam Browser behaves.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq } from "drizzle-orm";
import { registerForTests } from "@quiz/registry/server";

import { auditLog, launchTickets, sessions } from "../db/schema.js";
import { fakeShort } from "../test/fakeType.js";
import { routesOf, testServer, type Method, type TestServer } from "../test/http.js";
import { seedLive } from "../test/live.js";
import { consumeLaunchTicket, issueLaunchTicket } from "./launch.js";
import { CONFIG_KEY_HEADER } from "./seb.js";
import { launchSeb, openSebSession, sebStartUrl, SITTING_ROUTES } from "./testing.js";
import { kioskStation } from "../test/kiosk.js";
import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "./session.js";

type Who = { id: string; headers: Record<string, string> };
/** Fixed headers, or those of one URL: a `seb` session's Config Key header hashes the URL. */
type Headers = Record<string, string> | ((url: string) => Record<string, string>);

let server: TestServer;
let restore: () => void;
let teacher: Who;
let student: Who;
let exam: Awaited<ReturnType<typeof seedLive>>;
let other: Awaited<ReturnType<typeof seedLive>>;

const call = (method: Method, url: string, headers: Headers, payload: object = {}) =>
  server.app.inject({
    method,
    url,
    headers: typeof headers === "function" ? headers(url) : headers,
    ...(method === "GET" ? {} : { payload }),
  });

/** Downloads a `.seb` and returns the start URL written in it. */
const download = (evaluationId: string, who: Who = student): Promise<string> =>
  sebStartUrl(server, evaluationId, who.headers);

/** Opens the start URL as SEB would (or without its header), and returns the response. */
const launch = (startUrl: string, header?: string) => launchSeb(server, startUrl, header);

/** Downloads a `.seb` and opens it as SEB would. */
const sebSession = (evaluationId: string) => openSebSession(server, evaluationId, student.headers);

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  // Enforced, as it will be after proof B: every sitting request below must
  // carry its Config Key header (ADR-051 §3).
  server = await testServer({ SEB_CONFIG_KEY_ENFORCE: "1" });
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
      consumeLaunchTicket(server.app.db, "seb", secret, now),
      consumeLaunchTicket(server.app.db, "seb", secret, now),
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
  let seb: (url: string) => Record<string, string>;
  let attemptId: string;
  let otherAttemptId: string;

  beforeAll(async () => {
    seb = await sebSession(exam.evaluationId);
    // An attempt of the OTHER evaluation, entered through its own launch.
    const otherSeb = await sebSession(other.evaluationId);
    otherAttemptId = (await call("POST", `/app/api/evaluations/${other.evaluationId}/attempt`, otherSeb)).json().view.attempt.id;
  });

  it("sits its own evaluation", async () => {
    const me = await call("GET", "/app/api/me", seb);
    expect(me.json().session).toEqual({
      kind: "seb",
      evaluationId: exam.evaluationId,
      superPowersUntil: null,
      superPowersAvailable: false,
      readOnly: false,
    });
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
    const anonymous = (url: string) => {
      const { cookie: _, ...rest } = seb(url);
      return rest;
    };
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

/**
 * The same confinement for a `kiosk` session (ADR-051 §1, §7), which is only
 * worth something beside its station's `quiz_kiosk` cookie: with it, the
 * sweep above; without it, not even the sitting routes know the session.
 */
describe("the kiosk session (ADR-051)", () => {
  let station: Awaited<ReturnType<typeof kioskStation>>;
  let session: Record<string, string>;
  let kioskExam: Awaited<ReturnType<typeof seedLive>>;

  beforeAll(async () => {
    kioskExam = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [student.id],
      mode: "exam",
      settings: { kiosk: true },
    });
    const started = await call("POST", `/app/api/evaluations/${kioskExam.evaluationId}/start`, teacher.headers, {
      confirm: true,
    });
    expect(started.statusCode, started.body).toBe(200);
    station = await kioskStation(server.app);
    // What the station's poll opens once a phone approved it.
    const s = await createSession(server.app.db, student.id, 12, {
      kind: "kiosk",
      actorUserId: null,
      evaluationId: kioskExam.evaluationId,
      deviceId: station.deviceId,
    });
    session = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
  });

  const withStation = () => ({ ...session, cookie: `${session.cookie}; ${station.cookie}` });
  const url = (path: string) => path.replace(/:\w+/g, "00000000-0000-4000-8000-000000000000").replace("*", "x");
  const everyRoute = () =>
    routesOf(server.app.printRoutes({ commonPrefix: false })).filter(
      ({ path }) => !/^\/app\/auth\/(login|callback)$/.test(path),
    );

  it("sits its own evaluation from its station", async () => {
    expect((await call("GET", "/app/api/me", withStation())).json().session).toEqual({
      kind: "kiosk",
      evaluationId: kioskExam.evaluationId,
      readOnly: false,
      // ADR-054: a confined session never holds Super Powers.
      superPowersAvailable: false,
      superPowersUntil: null,
    });
    expect((await call("POST", `/app/api/evaluations/${kioskExam.evaluationId}/attempt`, withStation())).statusCode).toBe(200);
  });

  it("is no session at all, with its station, on every route that does not declare it", async () => {
    const stationOnly = { cookie: station.cookie };
    for (const { method, path } of everyRoute()) {
      if (SITTING_ROUTES.has(`${method} ${path}`)) continue;
      const [asKiosk, asNobody] = await Promise.all([
        call(method, url(path), withStation()),
        call(method, url(path), stationOnly),
      ]);
      expect(asKiosk.statusCode, `${method} ${path}`).toBe(asNobody.statusCode);
    }
  });

  it("is no session at all, without its station, even on the sitting routes", async () => {
    for (const { method, path } of everyRoute()) {
      if (!SITTING_ROUTES.has(`${method} ${path}`)) continue;
      const [alone, asNobody] = await Promise.all([call(method, url(path), session), call(method, url(path), {})]);
      expect(alone.statusCode, `${method} ${path}`).toBe(asNobody.statusCode);
      expect(alone.statusCode, `${method} ${path}`).toBe(401);
    }
  });
});

describe("the Config Key of every request (ADR-051 §3), enforced", () => {
  let seb: (url: string) => Record<string, string>;
  let attemptId: string;
  let bare: Record<string, string>;

  beforeAll(async () => {
    const sitting = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [student.id],
      mode: "exam",
      settings: { safeExamBrowser: true },
    });
    await call("POST", `/app/api/evaluations/${sitting.evaluationId}/start`, teacher.headers, { confirm: true });
    seb = await sebSession(sitting.evaluationId);
    attemptId = (await call("POST", `/app/api/evaluations/${sitting.evaluationId}/attempt`, seb)).json().view.attempt.id;
    const { [CONFIG_KEY_HEADER]: _, ...rest } = seb("/");
    bare = rest;
  });

  it("refuses a sitting route without the header or with another URL's, and serves its own", async () => {
    const url = `/app/api/attempts/${attemptId}`;
    expect((await call("GET", url, bare)).statusCode).toBe(401);
    expect((await call("GET", url, { ...bare, [CONFIG_KEY_HEADER]: seb("/app/api/me")[CONFIG_KEY_HEADER]! })).statusCode).toBe(401);
    expect((await call("GET", url, seb)).statusCode).toBe(200);
  });

  it("checks the event stream too, on its URL as sent (percent-encoded)", async () => {
    const url = `/app/api/events?watch=attempt%3A${attemptId}`;
    expect((await call("GET", url, bare)).statusCode).toBe(401);
    // The header of the decoded URL is another URL's.
    const decoded = seb(`/app/api/events?watch=attempt:${attemptId}`);
    expect((await call("GET", url, decoded)).statusCode).toBe(401);
    const hangUp = new AbortController();
    const res = await server.app.inject({ method: "GET", url, headers: seb(url), payloadAsStream: true, signal: hangUp.signal });
    expect(res.statusCode).toBe(200);
    res.stream().destroy();
    hangUp.abort();
  });
});

describe("a new confined session (ADR-051 §4)", () => {
  it("sets Strict cookies", async () => {
    const res = await launch(await download(exam.evaluationId));
    const byName = Object.fromEntries(res.cookies.map((c) => [c.name, c]));
    expect(byName[SESSION_COOKIE]?.sameSite).toBe("Strict");
    expect(byName[CSRF_COOKIE]?.sameSite).toBe("Strict");
  });

  it("supersedes the previous seb session of the pair, its stream included, and never the portal", async () => {
    const pair = and(eq(sessions.userId, student.id), eq(sessions.evaluationId, exam.evaluationId), eq(sessions.kind, "seb"));
    const first = await sebSession(exam.evaluationId);
    expect(await server.app.db.select().from(sessions).where(pair)).toHaveLength(1);
    const watch = `/app/api/events?watch=lobby:${exam.evaluationId}`;
    const hangUp = new AbortController();
    const stream = await server.app.inject({ method: "GET", url: watch, headers: first(watch), payloadAsStream: true, signal: hangUp.signal });
    expect(stream.statusCode).toBe(200);
    const ended = new Promise<void>((resolve) => stream.stream().on("end", resolve).resume());
    const dashboard = new AbortController();
    const staff = await server.app.inject({
      method: "GET",
      url: `/app/api/events?watch=evaluation:${exam.evaluationId}`,
      headers: teacher.headers,
      payloadAsStream: true,
      signal: dashboard.signal,
    });
    let frames = "";
    staff.stream().on("data", (chunk: Buffer) => (frames += chunk.toString("utf8")));

    const second = await sebSession(exam.evaluationId);
    await ended;
    expect(await server.app.db.select().from(sessions).where(pair)).toHaveLength(1);
    expect((await call("GET", "/app/api/me", first)).statusCode).toBe(401);
    expect((await call("GET", "/app/api/me", second)).statusCode).toBe(200);
    expect((await call("GET", "/app/api/me", student.headers)).statusCode).toBe(200);
    const [row] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "auth.session_superseded"), eq(auditLog.actorUserId, student.id)))
      .orderBy(auditLog.id)
      .limit(1);
    expect(row).toMatchObject({ subjectType: "evaluation", subjectId: exam.evaluationId });
    expect(row!.payload).toEqual({ userId: student.id, kinds: ["seb"], by: "seb" });
    await new Promise((resolve) => setImmediate(resolve));
    const alert = /^event: dashboard\.alert\ndata: (.+)$/m.exec(frames);
    expect(JSON.parse(alert![1]!)).toMatchObject({
      type: "dashboard.alert",
      evaluationId: exam.evaluationId,
      userId: student.id,
      kind: "session_superseded",
    });
    staff.stream().destroy();
    dashboard.abort();
    hangUp.abort();
  });
});
